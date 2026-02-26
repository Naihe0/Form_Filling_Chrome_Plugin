/**
 * InteractionHandler – LLM-driven agent loop for form interactions.
 *
 * Instead of hard-coding strategies for each widget type, this module
 * runs a general observe → ask LLM → execute → repeat loop.
 * The LLM sees the live DOM context at every step and decides what to
 * click, type, or select next until the field is filled or a step
 * limit is reached.
 */
const InteractionHandler = (() => {
  let _askLLM = null;
  let _statusUI = null;

  const MAX_STEPS = 8;

  /* ================================================================== */
  /* Low-level DOM Utilities                                             */
  /* ================================================================== */

  function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function _isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return (
      s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      s.opacity !== '0' &&
      el.offsetHeight > 0
    );
  }

  /** Dispatch a realistic mousedown → mouseup → click sequence. */
  function _simulateClick(el) {
    if (!el) return;
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  /** Set an input value using the native setter (React / Vue compatible). */
  function _setInputValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ================================================================== */
  /* DOM Observation                                                      */
  /* ================================================================== */

  /**
   * Watch for any newly added Element nodes (debounced).
   * Resolves with the list of added nodes once mutations settle, or on
   * hard timeout — whichever comes first.
   */
  function _waitForDOMSettle(timeout = 2000) {
    return new Promise((resolve) => {
      const added = [];
      let settleTimer = null;

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE) added.push(n);
          }
        }
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          observer.disconnect();
          resolve(added);
        }, 350);
      });

      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        clearTimeout(settleTimer);
        resolve(added);
      }, timeout);
    });
  }

  /* ================================================================== */
  /* Context Capture                                                      */
  /* ================================================================== */

  /**
   * Selectors used purely for DETECTING visible overlays / popups so we
   * can include their HTML in the context sent to the LLM.
   * These are NOT used for any interaction logic.
   */
  const OVERLAY_SELECTORS = [
    '[role="listbox"]',
    '[role="menu"]',
    '[role="tree"]',
    '[role="dialog"]:not([aria-hidden="true"])',
    '.ant-select-dropdown',
    '.ant-cascader-menus',
    '.ant-picker-dropdown',
    '.ant-picker-panel-container',
    '.ant-dropdown',
    '.el-select-dropdown',
    '.el-cascader-panel',
    '.el-picker-panel',
    '.el-popper:not([aria-hidden="true"])',
    '.el-autocomplete-suggestion',
    '.MuiPopover-paper',
    '.MuiMenu-list',
    '.MuiAutocomplete-popper',
    '.MuiPickersPopper-root',
    '.dropdown-menu.show',
    '[data-radix-popper-content-wrapper]',
    '[data-headlessui-state="open"]',
    '.v-menu__content',
    '.n-base-select-menu',
    '.ivu-select-dropdown',
    '.select-dropdown',
    '.autocomplete-results',
    '.suggestions',
    '.datepicker',
    '.calendar',
    '.flatpickr-calendar',
  ];

  /** Strip scripts / styles and collapse whitespace. */
  function _cleanHTML(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Build a snapshot of the current DOM context relevant to the field:
   *   1. The HTML surrounding the target field element.
   *   2. Any currently visible popups / overlay panels (which may be
   *      appended to <body> rather than inside the field's parent).
   */
  function _captureContext(fieldElement, radius = 3000) {
    const parts = [];

    // --- Part 1: field surroundings ---
    let el = fieldElement;
    let parent = el.parentElement;
    while (
      parent &&
      parent.outerHTML.length < radius &&
      parent.tagName !== 'BODY'
    ) {
      el = parent;
      parent = parent.parentElement;
    }
    parts.push('<!-- 字段区域 -->\n' + _cleanHTML(el.outerHTML));

    // --- Part 2: visible popups / overlays ---
    const seen = new Set();
    for (const sel of OVERLAY_SELECTORS) {
      for (const popup of document.querySelectorAll(sel)) {
        if (!_isVisible(popup) || el.contains(popup) || seen.has(popup))
          continue;
        seen.add(popup);
        const html = popup.outerHTML;
        parts.push(
          '<!-- 当前可见的弹出层/面板 -->\n' +
            _cleanHTML(html.length > 8000 ? html.substring(0, 8000) : html)
        );
      }
    }

    let result = parts.join('\n\n');
    if (result.length > 15000) result = result.substring(0, 15000);
    return result;
  }

  /* ================================================================== */
  /* Instruction Execution                                               */
  /* ================================================================== */

  /**
   * Execute a single LLM-generated instruction:
   *   { action, selector, value }
   */
  async function _executeInstruction(instr) {
    const { action, selector, value } = instr;

    const findEl = (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return el;
    };

    switch (action) {
      case 'click': {
        const el = findEl(selector);
        await _sleep(120);
        _simulateClick(el);
        break;
      }

      case 'type': {
        const el = findEl(selector);
        el.focus();
        _setInputValue(el, value);
        break;
      }

      case 'clear_and_type': {
        const el = findEl(selector);
        el.focus();
        _setInputValue(el, '');
        await _sleep(80);
        _setInputValue(el, value);
        break;
      }

      case 'select': {
        const el = findEl(selector);
        if (el.tagName !== 'SELECT')
          throw new Error('Target is not a <select> element.');
        el.focus();
        const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
        const target = norm(value);
        for (const opt of el.options) {
          if (
            opt.value === value ||
            opt.text === value ||
            norm(opt.text).includes(target) ||
            target.includes(norm(opt.text))
          ) {
            opt.selected = true;
            break;
          }
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }

      case 'focus': {
        const el = findEl(selector);
        el.focus();
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /* ================================================================== */
  /* LLM Prompt & Response Parsing                                       */
  /* ================================================================== */

  function _buildPrompt(field, value, contextHTML, history) {
    const valueStr = Array.isArray(value) ? value.join(' > ') : String(value);

    return `你是一个Web自动化操作专家。你正在帮助用户逐步填写在线表单中的一个字段。
每次只执行一个操作。

## 目标
将字段 "${field.question}" 的值设为: "${valueStr}"
${field.options?.length ? '已知选项: ' + field.options.join(', ') : ''}

## 已执行步骤
${history.length > 0 ? history.map((h, i) => (i + 1) + '. ' + h).join('\n') : '(尚未执行任何操作)'}

## 当前页面HTML (字段区域 + 弹出层)
\`\`\`html
${contextHTML}
\`\`\`

## 可用操作 (返回一个JSON对象)
- {"action":"click","selector":"<CSS>"} — 点击元素(打开下拉框/选日期/选选项等)
- {"action":"type","selector":"<CSS>","value":"<文本>"} — 输入文本
- {"action":"clear_and_type","selector":"<CSS>","value":"<文本>"} — 清空后输入
- {"action":"select","selector":"<CSS>","value":"<值>"} — 原生<select>选择
- {"action":"focus","selector":"<CSS>"} — 聚焦元素
- {"action":"done"} — 值已成功填入或选中，任务完成
- {"action":"fail","reason":"<原因>"} — 确认无法完成

## 规则
1. 仔细分析HTML中是否已有弹出的下拉列表、日历面板、级联面板等。
2. 如需先打开组件，返回点击触发器的操作。如组件已打开，直接选择目标。
3. CSS选择器须精确，能唯一定位目标。优先用 id、data-* 属性、nth-child 等。
4. 如果上一步操作失败，尝试换一种选择器或方案。
5. 只返回一个JSON对象，不要附带任何解释文字。`;
  }

  /** Parse the LLM response into an instruction object. */
  function _parseInstruction(raw) {
    // Already an object with 'action'
    if (raw && typeof raw === 'object' && raw.action) return raw;

    if (typeof raw !== 'string') return null;
    let text = raw.trim();

    // Strip code fences
    const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();

    // Extract the first {...} block
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.substring(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  /* ================================================================== */
  /* Agent Loop                                                          */
  /* ================================================================== */

  /**
   * Core LLM-driven agent loop.
   *
   * At each step:
   *   1. Capture the current DOM context around the field element.
   *   2. Send context + history to the LLM and ask "what next?".
   *   3. Execute the LLM's instruction.
   *   4. Wait for the DOM to settle.
   *   5. Repeat until "done", "fail", or step limit.
   */
  async function _agentLoop(fieldElement, field, value) {
    const history = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      // 1 — observe
      const contextHTML = _captureContext(fieldElement);

      // 2 — ask
      _statusUI?.update?.(
        typeof I18n !== 'undefined'
          ? I18n.t('csInteracting', { question: field.question }) +
              ` (${step + 1}/${MAX_STEPS})`
          : `Interacting: ${field.question} (${step + 1}/${MAX_STEPS})`
      );

      const prompt = _buildPrompt(field, value, contextHTML, history);
      const raw = await _askLLM(prompt);
      const instr = _parseInstruction(raw);

      if (!instr) {
        console.warn('[Agent] Could not parse LLM response:', raw);
        history.push('[系统] 无法解析LLM返回的指令');
        continue;
      }

      console.log(`[Agent] Step ${step + 1}:`, JSON.stringify(instr));

      // 3 — terminal states
      if (instr.action === 'done') {
        console.log('[Agent] LLM reports done.');
        return true;
      }
      if (instr.action === 'fail') {
        console.warn('[Agent] LLM reports failure:', instr.reason);
        return false;
      }

      // 4 — execute
      try {
        await _executeInstruction(instr);
        history.push(
          `${instr.action} → ${instr.selector || ''}` +
            (instr.value ? ` (value: "${instr.value}")` : '') +
            ' ✓'
        );
      } catch (e) {
        console.warn(`[Agent] Execution error at step ${step + 1}:`, e.message);
        history.push(
          `${instr.action} → ${instr.selector || ''}` +
            ` [失败: ${e.message}]`
        );
      }

      // 5 — wait for DOM to settle
      await _waitForDOMSettle(1800);
      await _sleep(250);
    }

    console.warn('[Agent] Reached step limit without completing.');
    return false;
  }

  /* ================================================================== */
  /* Lightweight Widget Detection                                        */
  /* ================================================================== */

  /**
   * Quick heuristic: does this element look like a complex interactive
   * widget (custom dropdown, date picker, cascader, autocomplete…)?
   *
   * Returns a truthy string when yes, null when no.
   * This is ONLY used as a gate to decide whether to engage the agent
   * loop proactively — the actual interaction logic is fully LLM-driven.
   */
  function detectInteractionType(el) {
    if (!el) return null;

    const cls =
      typeof el.className === 'string' ? el.className.toLowerCase() : '';
    const role = (el.getAttribute('role') || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ariaHP = el.getAttribute('aria-haspopup') || '';
    const ariaAC = el.getAttribute('aria-autocomplete') || '';

    // Native date / time — can be set directly, no agent needed
    if (['date', 'datetime-local', 'time', 'month', 'week'].includes(type)) {
      return 'native-date';
    }

    // ARIA hints
    if (
      role === 'combobox' ||
      ariaHP === 'listbox' ||
      ariaHP === 'true' ||
      ariaAC
    ) {
      return 'interactive';
    }

    // Common framework class patterns
    if (
      /ant-select|el-select|ant-picker|el-date|ant-cascader|el-cascader|mui.*picker|autocomplete|combobox|datepicker|cascad|n-base-select|ivu-select|v-select|searchable/i.test(
        cls
      )
    ) {
      return 'interactive';
    }

    // Check parent wrapper
    const parent = el.parentElement;
    if (parent) {
      const pCls =
        typeof parent.className === 'string'
          ? parent.className.toLowerCase()
          : '';
      if (
        /ant-select|el-select|ant-picker|el-date|ant-cascader|el-cascader|n-base-select/i.test(
          pCls
        )
      ) {
        return 'interactive';
      }
    }

    return null;
  }

  /* ================================================================== */
  /* Public Entry Point                                                  */
  /* ================================================================== */

  /**
   * Attempt to fill an interactive field via the LLM agent loop.
   *
   * @param {Element} triggerEl  The element associated with the field.
   * @param {Object}  field      Field descriptor from FieldExtractor.
   * @param {any}     value      Target value(s) to fill / select.
   * @returns {Promise<boolean>} True if the agent completed the task.
   */
  async function handleInteractiveField(triggerEl, field, value) {
    if (!triggerEl || value == null) return false;

    // Native date inputs are trivial — set directly.
    const iType = field.interactionType || detectInteractionType(triggerEl);
    if (iType === 'native-date') {
      const v = Array.isArray(value) ? value[0] : value;
      _setInputValue(triggerEl, v);
      return true;
    }

    // Everything else: let the LLM drive.
    return _agentLoop(triggerEl, field, value);
  }

  /* ================================================================== */
  /* Module Interface                                                    */
  /* ================================================================== */

  return {
    /**
     * @param {Object}   config
     * @param {Function} config.askLLM   – (prompt) => Promise<any>
     * @param {Object}   config.statusUI – StatusUI instance
     */
    init(config) {
      _askLLM = config.askLLM || null;
      _statusUI = config.statusUI || null;
    },

    handleInteractiveField,
    detectInteractionType,
  };
})();
