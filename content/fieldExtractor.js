/**
 * FieldExtractor - Extracts form fields from the page using LLM.
 *
 * Chunks the visible HTML, asks the LLM to identify fillable fields,
 * de-duplicates, and optionally assigns values from the user profile.
 */
const FieldExtractor = (() => {
  let _statusUI = null;
  let _isStopped = () => false;
  let _askLLM = null;

  /* ------------------------------------------------------------------ */
  /* Private helpers                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Extract the outermost JSON array or object substring from a larger
   * text that may contain explanatory prose before/after the JSON.
   */
  function _extractOuterJSON(text) {
    const arrStart = text.indexOf('[');
    const objStart = text.indexOf('{');
    let start = -1;
    let close = '';

    if (arrStart >= 0 && (objStart < 0 || arrStart <= objStart)) {
      start = arrStart;
      close = ']';
    } else if (objStart >= 0) {
      start = objStart;
      close = '}';
    }
    if (start < 0) return null;

    const end = text.lastIndexOf(close);
    if (end <= start) return null;

    return text.substring(start, end + 1);
  }

  /**
   * Attempt to repair common LLM JSON issues:
   *  - Unescaped ASCII double-quotes inside string values
   *    (e.g. Chinese text like  "主导了"跨境支付"功能" )
   *  - Literal newlines / tabs inside string values
   */
  function _repairJSON(str) {
    let result = '';
    let inString = false;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];

      // Preserve existing escape sequences inside strings
      if (ch === '\\' && inString && i + 1 < str.length) {
        result += ch + str[i + 1];
        i++;
        continue;
      }

      if (ch === '"') {
        if (!inString) {
          // Opening a string
          inString = true;
          result += '"';
        } else {
          // We are inside a string and hit a " — is this the real closing
          // quote, or an unescaped embedded quote?
          // Heuristic: peek at the next non-whitespace character.
          // A real closing quote is followed by  , ] } :  or end-of-input.
          let j = i + 1;
          while (j < str.length && /[ \t\r\n]/.test(str[j])) j++;
          const peek = str[j];

          if (!peek || /[,\]}\:]/.test(peek)) {
            // Real end of string
            inString = false;
            result += '"';
          } else {
            // Unescaped quote inside the string value — escape it
            result += '\\"';
          }
        }
      } else if (inString && ch === '\n') {
        result += '\\n';
      } else if (inString && ch === '\r') {
        result += '\\r';
      } else if (inString && ch === '\t') {
        result += '\\t';
      } else {
        result += ch;
      }
    }
    return result;
  }

  /**
   * Robustly coerce an LLM response into a JavaScript array.
   *
   * Strategies (tried in order):
   *  1. data is already an array → return it.
   *  2. data is a string →
   *     a. Strip markdown code fences.
   *     b. Direct JSON.parse on the whole text.
   *     c. Extract the outermost [...] or {...} and JSON.parse.
   *     d. Repair common JSON issues and JSON.parse.
   *  3. data is an object wrapping an array → unwrap.
   */
  function _ensureArray(data) {
    // 1. Already an array
    if (Array.isArray(data)) return data;

    // 2. String — multi-strategy parsing
    if (typeof data === 'string') {
      let text = data.trim();
      if (!text) return null;

      // Strip markdown code fences (anywhere in the string)
      const fenceMatch = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
      if (fenceMatch) text = fenceMatch[1].trim();

      // Strategy A: direct parse on the (possibly fence-stripped) text
      try { return _ensureArray(JSON.parse(text)); } catch { /* continue */ }

      // Strategy B: extract outermost JSON structure and parse
      const extracted = _extractOuterJSON(text);
      if (extracted) {
        try { return _ensureArray(JSON.parse(extracted)); } catch { /* continue */ }

        // Strategy C: repair common issues (unescaped quotes, control chars) then parse
        try { return _ensureArray(JSON.parse(_repairJSON(extracted))); } catch { /* continue */ }
      }

      // Strategy D: repair the full text and parse
      try { return _ensureArray(JSON.parse(_repairJSON(text))); } catch { /* continue */ }

      return null;
    }

    // 3. Object wrapping an array — find the first array-valued key
    if (data && typeof data === 'object') {
      const arrayKey = Object.keys(data).find((k) => Array.isArray(data[k]));
      if (arrayKey) return data[arrayKey];
      // Single object — wrap it
      return [data];
    }

    return null;
  }

  /**
   * Send a single HTML chunk to the LLM and get back an array of field objects.
   */
  async function _processChunk(html, chunkIndex) {
    const prompt = `你是一个HTML解析专家。严格分析以下网页问卷的HTML片段，
并仅返回此片段中存在的所有问卷问题，选项等信息。输出一个纯JSON数组，
其中每个对象代表一个问题。

分块处理: 正在处理多个块中的第 ${chunkIndex} 块。

每个字段对象必须包含:
- 'question': 问题文本。
- 'action': "click" 或 "fill"。
- 'selector': 用来回答当前问题，能够用JavaScript代码发起事件进行点击或者填充的选择器数组。
    * 如果问题是**普通单选/多选题**（如 radio/checkbox），返回包含所有选项对应选择器的数组。
    * 如果问题使用**自定义下拉框、日期选择器、级联选择器、搜索选择框**等动态交互组件，'selector' 应只包含**触发器元素**的选择器（即点击后打开弹出层的那个元素）。
- 'options': 一个包含所有可用选项文本的数组。如果选项是动态渲染的（如下拉框点击后才显示），可以留空数组 []。
- 'interactionType': (可选字段) 如果该问题需要多步交互才能完成选择，请设置此字段。可选值：
    * "dropdown" — 自定义下拉列表（非原生 <select>），需要点击触发器后从弹出列表中选择。
    * "datepicker" — 日期/时间选择器，需要从日历面板中选择日期。
    * "cascading" — 级联选择器（如省市区），需要逐级选择。
    * "search-select" — 搜索/自动补全选择器，需要输入文字后从搜索结果中选择。
    * 如果是**普通输入框、复选框、单选按钮或原生 <select>**，不要设置此字段。

指南:
1. **严格性**: 只分析提供的HTML。不要猜测或包含HTML之外的字段。确保输出是纯粹的、格式正确的JSON数组，不包含任何解释性文本。

HTML片段如下:
\`\`\`html
${html}
\`\`\``;

    try {
      const raw = await _askLLM(prompt);
      const fields = _ensureArray(raw);
      return fields || [];
    } catch (e) {
      console.error(`[FieldExtractor] Error processing chunk #${chunkIndex}:`, e);
      return [];
    }
  }

  /**
   * Chunk the page body HTML and extract all form fields.
   */
  async function _extractFieldsFromPage() {
    const clone = document.body.cloneNode(true);
    clone
      .querySelectorAll('script, style, noscript, svg, footer, nav')
      .forEach((el) => el.remove());

    const MAX_CHUNK_SIZE = 15000;
    const chunks = [];
    let currentChunk = '';

    let container = clone;
    if (clone.children.length === 1 && clone.children[0].children.length > 1) {
      container = clone.children[0];
    }

    for (const element of Array.from(container.children)) {
      const html = element.outerHTML;
      if (!html) continue;
      if (currentChunk.length + html.length > MAX_CHUNK_SIZE && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      currentChunk += html + '\n';
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const allFields = [];
    for (const [index, chunk] of chunks.entries()) {
      if (_isStopped()) return [];

      if (_statusUI) {
        _statusUI.startTimer(
          `${I18n.t('csExtractingFields')}... (${index + 1}/${chunks.length})`
        );
      }

      const result = await _processChunk(chunk, index + 1);
      if (result && Array.isArray(result)) {
        allFields.push(...result.map((f) => ({ ...f, htmlChunk: chunk })));
      }
      await new Promise((r) => setTimeout(r, 500)); // rate-limit
    }

    // De-duplicate by question + selector
    const seen = new Set();
    return allFields.filter((f) => {
      if (!f.selector) return false;
      const key = `${f.question}|${f.selector}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Ask the LLM to add a 'value' key to each field based on the user profile.
   */
  async function _addValuesToFields(fields, profile) {
    const fieldsForPrompt = fields.map(({ htmlChunk, ...rest }, index) => ({
      ...rest,
      _id: index,
    }));

    const prompt = `你是一个高度智能的AI表单填充助手。你的任务是根据用户资料，为给定的JSON字段数组中的每个对象添加一个 'value' 键。

--- 用户资料 ---
${profile}

--- 表单字段 (JSON数组) ---
${JSON.stringify(fieldsForPrompt, null, 2)}

--- 填充规则 ---
1. **分析**: 仔细分析每个字段对象的 'question', 'action', 'options', 和 'interactionType'。
2. **填充 'value'**: 根据用户资料和问题，确定最匹配的填充值。
    * 对于 **"action": "fill"**，'value' 应该是一个包含 **字符串** 的数组。
    * 对于 **"action": "click"**：
      - 如果 'options' 数组**不为空**，'value' 应该从 'options' 中选择。
      - 如果 'options' 为**空数组**（如动态下拉框、日期选择器等），直接根据问题和用户资料生成合适的值。
    * 对于 **"interactionType": "datepicker"**，'value' 应该是日期字符串（格式：YYYY-MM-DD）。
    * 对于 **"interactionType": "cascading"**，'value' 应该是一个**有序数组**，每个元素对应一个级联层级（如 ["广东省", "深圳市", "南山区"]）。
    * 如果根据用户资料找不到任何匹配的答案，请 **不要** 添加 'value' 键。
3. **保留ID**: 你 **必须** 在返回的每个JSON对象中保留原始的 '_id' 字段。
4. **保留 interactionType**: 如果原始字段有 'interactionType'，请保留。
5. **输出**: 你的输出必须是，也只能是一个JSON数组。

--- 输出 (修改后的JSON数组) ---`;

    try {
      const raw = await _askLLM(prompt);
      const updated = _ensureArray(raw);

      if (!updated) {
        console.error(
          '[FieldExtractor] LLM did not return a valid array.',
          '\n  typeof raw:', typeof raw,
          '\n  first 200 chars:', typeof raw === 'string' ? raw.substring(0, 200) : raw
        );
        return fields;
      }

      const updateMap = new Map(
        updated.filter((f) => f._id !== undefined).map((f) => [f._id, f])
      );

      return fields.map((original, index) => {
        const patched = updateMap.get(index);
        if (patched) {
          const { _id, ...rest } = patched;
          return { ...original, ...rest };
        }
        return original;
      });
    } catch (e) {
      console.error('[FieldExtractor] Error adding values:', e);
      return fields;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public interface                                                    */
  /* ------------------------------------------------------------------ */

  return {
    /**
     * Initialise module dependencies. Must be called before extractFields.
     * @param {Object} config
     * @param {StatusUI}  config.statusUI
     * @param {Function}  config.askLLM     - (prompt:string) => Promise<any>
     * @param {Function}  config.isStopped  - () => boolean
     */
    init(config) {
      _statusUI = config.statusUI;
      _isStopped = config.isStopped;
      _askLLM = config.askLLM;
    },

    /** Extract all fillable form fields from the current page. */
    extractFields() {
      return _extractFieldsFromPage();
    },

    /** Add values to extracted fields using the user profile. */
    addValuesToFields: _addValuesToFields,
  };
})();
