/**
 * FieldProcessor - Processes and fills individual form fields.
 *
 * Handles click/fill actions, ambiguity resolution when multiple
 * elements match a selector, and LLM-based correction on failure.
 */
const FieldProcessor = (() => {
  let _statusUI = null;
  let _filledFields = null; // Set<string>
  let _askLLM = null;
  let _correctionEnabled = false;

  /* ================================================================== */
  /* DOM Helpers                                                         */
  /* ================================================================== */

  function _getUniqueSelector(el) {
    if (!(el instanceof Element)) return '';
    const path = [];
    while (el.nodeType === Node.ELEMENT_NODE) {
      let selector = el.nodeName.toLowerCase();
      if (el.id) {
        path.unshift(selector + '#' + el.id);
        break;
      }
      let sib = el;
      let nth = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName.toLowerCase() === selector) nth++;
      }
      if (nth !== 1) selector += `:nth-of-type(${nth})`;
      path.unshift(selector);
      el = el.parentNode;
    }
    return path.join(' > ');
  }

  function _getSurroundingHtml(element, radius = 2000) {
    let parent = element.parentElement;
    if (!parent) return element.outerHTML;
    while (parent && parent.outerHTML.length < radius && parent.tagName !== 'BODY') {
      element = parent;
      parent = parent.parentElement;
    }
    return element.outerHTML;
  }

  function _getVisibleHtml() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
    return clone.outerHTML;
  }

  /* ================================================================== */
  /* Action Execution                                                    */
  /* ================================================================== */

  async function _executeAction(element, action, value) {
    return new Promise(async (resolve, reject) => {
      try {
        const isClickType =
          action.toLowerCase().includes('click') ||
          element.tagName === 'BUTTON' ||
          ['button', 'submit'].includes(element.type) ||
          element.role === 'button';

        if (isClickType) {
          element.focus();
          // Realistic mouse event sequence for better framework compatibility
          const mOpts = { bubbles: true, cancelable: true, view: window };
          element.dispatchEvent(new MouseEvent('mousedown', mOpts));
          element.dispatchEvent(new MouseEvent('mouseup', mOpts));
          element.dispatchEvent(new MouseEvent('click', mOpts));
          if (!(await _verifyClick(element))) {
            // Second attempt with direct .click()
            element.click();
            if (!(await _verifyClick(element))) {
              reject(new Error(`Click failed: ${element.tagName} (${element.className})`));
              return;
            }
          }
        } else if (action.toLowerCase().includes('select') || element.tagName === 'SELECT') {
          element.focus();
          const valStr = Array.isArray(value) ? value[0] : value;
          let matched = false;
          for (const opt of element.options) {
            if (
              opt.value === valStr ||
              opt.text === valStr ||
              opt.text.includes(valStr) ||
              valStr.includes(opt.text)
            ) {
              opt.selected = true;
              matched = true;
              break;
            }
          }
          if (!matched) {
            // Fuzzy match as last resort
            const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
            const target = norm(valStr);
            for (const opt of element.options) {
              if (norm(opt.text).includes(target) || target.includes(norm(opt.text))) {
                opt.selected = true;
                break;
              }
            }
          }
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          // Default: fill / input — use native setter for React / Vue compat
          element.focus();
          const fillVal = Array.isArray(value) ? value[0] : value;
          const proto = Object.getPrototypeOf(element);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(element, fillVal);
          else element.value = fillVal;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  async function _verifyClick(element) {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (element.type === 'radio' || element.type === 'checkbox') {
          return resolve(element.checked);
        }
        if (
          element.getAttribute('aria-checked') === 'true' ||
          element.getAttribute('aria-selected') === 'true'
        ) {
          return resolve(true);
        }
        if (!document.body.contains(element)) return resolve(true);

        const style = window.getComputedStyle(element);
        const isVisible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          element.offsetParent !== null;
        if (!isVisible) return resolve(true);

        resolve(!element.disabled);
      }, 500);
    });
  }

  /* ================================================================== */
  /* LLM Correction                                                      */
  /* ================================================================== */

  async function _correctWithLLM(originalField, error, profile) {
    const timeout = _correctionEnabled ? 60000 : 30000;

    // Build HTML context around the failed field
    let htmlContext = '';
    if (originalField.question) {
      const bodyHtml = document.body.outerHTML;
      const idx = bodyHtml.indexOf(originalField.question);
      if (idx !== -1) {
        const start = Math.max(0, idx - 1000);
        const end = Math.min(bodyHtml.length, idx + originalField.question.length + 3000);
        htmlContext = bodyHtml.substring(start, end);
      }
    }
    if (!htmlContext) {
      try {
        const el = document.querySelector(originalField.selector);
        htmlContext = el ? _getSurroundingHtml(el) : _getVisibleHtml();
      } catch {
        htmlContext = _getVisibleHtml();
      }
    }
    if (htmlContext.length > 15000) {
      htmlContext = htmlContext.substring(0, 15000);
    }

    const prompt = `你是一个Web自动化专家。一个自动化脚本在网页上填充字段时可能失败了。
失败的字段信息:
- 问题: "${originalField.question}"
- 尝试的CSS选择器: "${originalField.selector}"
- 如果是选择题，所有可选项："${originalField.options}"
- 字段类型: "${originalField.action}"
- 期望填充/选择的值: "${originalField.value || '(无特定值)'}"

这是该字段相关的HTML上下文:
\`\`\`html
${htmlContext}
\`\`\`

用户个人资料如下:
\`\`\`json
${JSON.stringify(profile, null, 2)}
\`\`\`

请分析HTML并提供一个修正方案。返回一个JSON对象:
- 如果原始选择器是错误的，请提供 \`newSelector\` 数组，确保与 \`newOptions\` 对齐。
- 如果 \`options\` 不正确，请提供 \`newOptions\` 数组。
- 如果 \`action\` 不正确，请提供 \`newAction\`。
- 如果 \`value\` 不正确，请提供 \`newValue\` 数组。
- 如果你认为这个字段无法被修复，返回 \`{"error": "原因"}\`。

返回格式:
{
  "newSelector": "[<correct_css_selector>]",
  "newOptions": "[<corrected_options>]",
  "newAction": "<input|click|select>",
  "newValue": "[<corrected_value>]"
}`;

    try {
      const corrected = await Promise.race([
        _askLLM(prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Correction timed out')), timeout)
        ),
      ]);

      if (corrected?.error) return null;

      if (corrected?.newSelector) {
        return {
          ...originalField,
          selector: corrected.newSelector,
          options: corrected.newOptions || originalField.options,
          action: corrected.newAction || originalField.action,
          value: corrected.newValue || originalField.value,
        };
      }

      return originalField; // retry with original
    } catch {
      return null;
    }
  }

  /* ================================================================== */
  /* Ambiguity Resolution                                                */
  /* ================================================================== */

  function _resolveAmbiguity(elements, selector, action, question, value) {
    const normalize = (str) => (str || '').replace(/\s+/g, '').toLowerCase();
    const normQuestion = normalize(question);
    let best = null;

    if (action.toLowerCase().includes('click')) {
      const normAnswer = normalize(value);
      let minDist = Infinity;
      let bestContainer = null;

      for (const el of elements) {
        let parent = el.parentElement;
        let distance = 1;
        while (parent && distance < 10) {
          if (normalize(parent.textContent).includes(normQuestion)) {
            if (distance < minDist) {
              minDist = distance;
              bestContainer = parent;
            }
            break;
          }
          parent = parent.parentElement;
          distance++;
        }
      }

      if (bestContainer) {
        for (const el of Array.from(bestContainer.querySelectorAll(selector))) {
          if (normalize(el.textContent || el.innerText || el.value).includes(normAnswer)) {
            best = el;
            break;
          }
        }
      }
    } else {
      let minDist = Infinity;
      for (const el of elements) {
        const uid = _getUniqueSelector(el);
        if (_filledFields.has(uid)) continue;
        let parent = el.parentElement;
        let distance = 1;
        while (parent && distance < 10) {
          const normLabel = normalize(parent.textContent);
          if (
            normLabel &&
            (normLabel.includes(normQuestion) || normQuestion.includes(normLabel))
          ) {
            if (distance < minDist) {
              minDist = distance;
              best = el;
            }
            break;
          }
          parent = parent.parentElement;
          distance++;
        }
      }
    }

    return best || elements.find((el) => !_filledFields.has(_getUniqueSelector(el))) || null;
  }

  /* ================================================================== */
  /* Main Processing                                                     */
  /* ================================================================== */

  /** Handle radio-button / checkbox groups where selector is an array. */
  async function _processClickGroup(field, value, profile, attempt = 0) {
    const values = Array.isArray(value) ? value : [value];
    let allOk = true;
    let lastError = null;

    for (const val of values) {
      const optIdx = field.options.findIndex(
        (opt) => opt.includes(val) || val.includes(opt)
      );
      if (optIdx === -1) {
        allOk = false;
        lastError = new Error(`Option "${val}" not found.`);
        continue;
      }

      const targetSelector = field.selector[optIdx];
      if (!targetSelector) {
        allOk = false;
        lastError = new Error(`Invalid selector at index ${optIdx}.`);
        continue;
      }

      try {
        const el = document.querySelector(targetSelector);
        if (!el) throw new Error(`Element not found: ${targetSelector}`);

        el.style.transition = 'all 0.3s';
        el.style.border = '2px solid red';
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise((r) => setTimeout(r, 100));

        await _executeAction(el, 'click', val);
        el.style.border = '2px solid green';
        _filledFields.add(_getUniqueSelector(el));
      } catch (e) {
        allOk = false;
        lastError = e;
      }
    }

    if (!allOk && attempt < 1) {
      _statusUI.startTimer(I18n.t('csGroupCorrecting'));
      try {
        const corrected = await _correctWithLLM({ ...field, value: values }, lastError, profile);
        if (corrected?.selector && corrected?.action) {
          _statusUI.update(I18n.t('csCorrectionSuccess', { question: field.question }));
          await _processClickGroup(corrected, corrected.value || values, profile, attempt + 1);
        } else {
          throw new Error('Correction returned no valid fix.');
        }
      } catch {
        _statusUI.update(I18n.t('csFieldFailed', { question: field.question }));
      }
    }
  }

  /** Process a single field: locate, resolve ambiguity, execute, correct. */
  async function _processSingleField(field, value, profile) {
    // Delegate click groups to dedicated handler
    if (
      Array.isArray(field.selector) &&
      field.action.toLowerCase().includes('click') &&
      field.options &&
      value
    ) {
      return _processClickGroup(field, value, profile);
    }

    let { selector, action, question } = field;
    const valueToFill = value || field.value;
    const MAX_RETRIES = 2;
    let lastError = null;
    let elementToProcess = null;

    // --- Ambiguity resolution ---
    try {
      const elements = Array.from(document.querySelectorAll(selector));
      if (elements.length > 1) {
        elementToProcess = _resolveAmbiguity(elements, selector, action, question, valueToFill);
      } else if (elements.length === 1) {
        elementToProcess = elements[0];
      }
      if (elementToProcess) {
        const uid = _getUniqueSelector(elementToProcess);
        if (_filledFields.has(uid)) return;
        selector = uid;
      }
    } catch {
      /* fall through to retry loop */
    }

    // --- Multi-step interaction check ---
    // If the field is flagged as interactive or the DOM element looks
    // like a dynamic widget, engage the LLM agent loop first.
    let triedAgentLoop = false;

    if (typeof InteractionHandler !== 'undefined') {
      const targetEl = elementToProcess || (() => {
        try { return document.querySelector(selector); } catch { return null; }
      })();

      if (targetEl) {
        const iType =
          field.interactionType ||
          InteractionHandler.detectInteractionType(targetEl);

        if (iType) {
          triedAgentLoop = true;
          _statusUI?.update?.(I18n.t('csInteracting', { question }));

          targetEl.style.transition = 'all 0.3s';
          targetEl.style.border = '2px solid #f59e0b'; // amber
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise((r) => setTimeout(r, 200));

          const success = await InteractionHandler.handleInteractiveField(
            targetEl,
            field,
            valueToFill
          );

          if (success) {
            targetEl.style.border = '2px solid green';
            targetEl.style.backgroundColor = '#f0fff0';
            await new Promise((r) => setTimeout(r, 800));
            targetEl.style.border = '';
            targetEl.style.backgroundColor = '';
            _filledFields.add(selector);
            return; // done
          }

          // Agent failed — clear highlights, fall through to simple approach
          targetEl.style.border = '';
          targetEl.style.backgroundColor = '';
          console.log(
            `[FieldProcessor] Agent loop failed for "${question}", trying simple approach.`
          );
        }
      }
    }

    // --- Retry loop (simple fill / click) ---
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let element;
      try {
        element = document.querySelector(selector);
      } catch (e) {
        lastError = e;
        continue;
      }
      if (!element) {
        lastError = new Error(`Element not found: ${selector}`);
        continue;
      }

      // Visual highlight
      element.style.transition = 'all 0.3s';
      element.style.border = '2px solid red';
      element.style.backgroundColor = '#fff0f0';
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise((r) => setTimeout(r, 300));

      try {
        await _executeAction(element, action, valueToFill);

        element.style.border = '2px solid green';
        element.style.backgroundColor = '#f0fff0';
        await new Promise((r) => setTimeout(r, 1000));
        element.style.border = '';
        element.style.backgroundColor = '';

        _filledFields.add(selector);
        return; // success
      } catch (e) {
        lastError = e;
        element.style.border = '2px solid #b91c1c';
      }
    }

    // --- Fallback: LLM agent loop (for fields NOT pre-detected as interactive) ---
    if (!triedAgentLoop && typeof InteractionHandler !== 'undefined') {
      const fallbackEl = (() => {
        try { return document.querySelector(selector); } catch { return null; }
      })();

      if (fallbackEl) {
        _statusUI?.update?.(I18n.t('csInteracting', { question }));
        fallbackEl.style.border = '2px solid #f59e0b';

        const success = await InteractionHandler.handleInteractiveField(
          fallbackEl,
          field,
          valueToFill
        );

        if (success) {
          fallbackEl.style.border = '2px solid green';
          fallbackEl.style.backgroundColor = '#f0fff0';
          await new Promise((r) => setTimeout(r, 800));
          fallbackEl.style.border = '';
          fallbackEl.style.backgroundColor = '';
          _filledFields.add(selector);
          return; // done
        }
        fallbackEl.style.border = '';
      }
    }

    // --- LLM selector correction (last resort) ---
    _statusUI.update(I18n.t('csCorrecting'));

    try {
      const corrected = await _correctWithLLM(
        { ...field, selector, value: valueToFill },
        lastError,
        profile
      );
      if (corrected?.selector && corrected?.action) {
        _statusUI.update(I18n.t('csCorrectionSuccess', { question }));
        const el = document.querySelector(corrected.selector);
        if (el) {
          await _executeAction(el, corrected.action, corrected.value || valueToFill);
          _filledFields.add(_getUniqueSelector(el));
        } else {
          throw new Error('Element not found after correction.');
        }
      } else {
        throw new Error('Correction returned no valid fix.');
      }
    } catch {
      _statusUI.update(I18n.t('csFieldFailed', { question }));
    }
  }

  /* ================================================================== */
  /* Public interface                                                    */
  /* ================================================================== */

  return {
    /**
     * Initialise module dependencies. Must be called before processSingleField.
     * @param {Object} config
     * @param {StatusUI}    config.statusUI
     * @param {Set<string>} config.successfullyFilledFields
     * @param {Function}    config.askLLM
     * @param {boolean}     config.correctionEnabled
     */
    init(config) {
      _statusUI = config.statusUI;
      _filledFields = config.successfullyFilledFields;
      _askLLM = config.askLLM;
      _correctionEnabled = !!config.correctionEnabled;
    },

    /** Process one field: locate element, execute action, correct on failure. */
    processSingleField: _processSingleField,
  };
})();
