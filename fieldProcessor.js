// ========================================================================
// == FIELD PROCESSOR                                                  ==
// ========================================================================
// This object encapsulates the logic for processing a single form field.
// It is designed to be called from the main content script.

const FieldProcessor = {
    // These will be initialized by the main agent
    statusUI: null,
    successfully_filled_fields: null,
    askLLM: null,

    /**
     * Initializes the FieldProcessor with necessary dependencies from the calling agent.
     * @param {object} agentContext - The context from the FormFillerAgent.
     * @param {StatusUI} agentContext.statusUI - The UI handler for status updates.
     * @param {Set<string>} agentContext.successfully_filled_fields - A set of selectors for already filled fields.
     * @param {function} agentContext.askLLM - The function to communicate with the LLM.
     */
    init(agentContext) {
        this.statusUI = agentContext.statusUI;
        this.successfully_filled_fields = agentContext.successfully_filled_fields;
        this.askLLM = agentContext.askLLM;
    },

    /**
     * Processes a single field: finds the element, handles ambiguity, executes the action,
     * and retries with LLM correction on failure.
     * @param {object} field - The field object from the LLM.
     * @param {string} value - The value to fill in.
     * @param {object} profile - The user's profile data.
     */
    async processSingleField(field, value, profile) {
        let { selector, action, question } = field;
        const MAX_RETRIES = 2;
        let lastError = null;
        let elementToProcess = null;

        // --- Ambiguity Resolution ---
        try {
            const potentialElements = Array.from(document.querySelectorAll(selector));

            if (potentialElements.length > 1) {
                console.log(`[歧义处理] 选择器 "${selector}" 匹配到 ${potentialElements.length} 个元素。将通过问题文本 "${question}" 进行精确定位。`);
                
                let minDistance = Infinity;
                let bestElement = null;
                let bestLabel = '';
                const normalize = str => (str || '').replace(/\\s+/g, '').toLowerCase();
                const normQuestion = normalize(question);

                for (const el of potentialElements) {
                    const uniqueElSelector = this.getUniqueSelector(el);
                    if (this.successfully_filled_fields.has(uniqueElSelector)) {
                        continue; // Skip already filled elements
                    }

                    let parent = el.parentElement;
                    let distance = 1;
                    let found = false;
                    let foundLabel = '';
                    while (parent && distance < 10) {
                        const labelText = parent.textContent ? parent.textContent.trim() : '';
                        const normLabel = normalize(labelText);
                        if (normLabel && (normLabel.includes(normQuestion) || normQuestion.includes(normLabel))) {
                            found = true;
                            foundLabel = labelText;
                            break;
                        }
                        parent = parent.parentElement;
                        distance++;
                    }
                    if (found && distance < minDistance) {
                        minDistance = distance;
                        bestElement = el;
                        bestLabel = foundLabel;
                    }
                }
                
                if (bestElement) {
                    console.log(`[歧义处理] 选择距离问题文本最近的元素 (父节点内容: "${bestLabel}")。`);
                    elementToProcess = bestElement;
                }
            } else if (potentialElements.length === 1) {
                elementToProcess = potentialElements[0];
            }

            if (elementToProcess) {
                const uniqueSelector = this.getUniqueSelector(elementToProcess);
                if (this.successfully_filled_fields.has(uniqueSelector)) {
                     console.warn(`[歧义处理] 目标元素 ${uniqueSelector} (问题: "${question}") 已经被填充过，将跳过。`);
                     return;
                }
                selector = uniqueSelector;
            }
            
        } catch (e) {
            console.warn(`初始选择器 "${selector}" 无效: ${e.message}`);
        }
        // --- End of Ambiguity Resolution ---

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            let element;
            try {
                element = document.querySelector(selector);
            } catch (e) {
                console.error(`[尝试 ${attempt}] 选择器 "${selector}" 无效:`, e.message);
                lastError = e;
                continue;
            }

            if (!element) {
                lastError = new Error(`Element not found with selector: ${selector}`);
                console.error(`[尝试 ${attempt}] 未找到元素: ${selector}`);
                continue;
            }

            // Visual feedback for the user
            element.style.transition = 'all 0.3s';
            element.style.border = '2px solid red';
            element.style.backgroundColor = '#fff0f0';
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 300));

            try {
                await this.executeAction(element, action, value);
                console.log(`✅ [尝试 ${attempt}] 成功: Action '${action}' on '${question}' with selector '${selector}'`);
                
                // Cleanup visual feedback
                element.style.border = '2px solid green';
                element.style.backgroundColor = '#f0fff0';
                await new Promise(r => setTimeout(r, 1000));
                element.style.border = '';
                element.style.backgroundColor = '';

                this.successfully_filled_fields.add(selector);
                return; // Success, exit the function

            } catch (e) {
                lastError = e;
                console.error(`[尝试 ${attempt}] 失败: Action '${action}' on '${question}'. Error:`, e.message);
                element.style.border = '2px solid #b91c1c'; // Darker red for error
            }
        }
        
        console.error(`常规尝试最终失败: Action '${action}' on '${question}'. 正在调用 LLM 进行纠错...`);
        
        this.statusUI.update(`🤔 字段 "${question}" 填充失败，尝试纠错...`);
        const fieldForCorrection = { ...field, selector: selector };
        try {
            const correctedField = await this.correctFieldWithLLM(fieldForCorrection, lastError, profile);

            if (correctedField && correctedField.selector && correctedField.action) {
                this.statusUI.update(`✅ 纠错成功，正在重试字段 "${question}"...`);
                console.log("[纠错后重试] 使用LLM修正后的新参数:", correctedField);
                const finalElement = document.querySelector(correctedField.selector);
                if (finalElement) {
                    await this.executeAction(finalElement, correctedField.action, correctedField.value || value);
                    this.successfully_filled_fields.add(correctedField.selector);
                    console.log(`✅ [纠错后] 成功: Action '${correctedField.action}' on '${question}'`);
                } else {
                    throw new Error("LLM 纠错后仍然找不到元素。");
                }
            } else {
                 throw new Error("LLM 纠错未能返回有效的选择器或操作。");
            }
        } catch (correctionError) {
            console.error(`❌ 字段 "${question}" 彻底失败，LLM 纠错也无效:`, correctionError.message);
            this.statusUI.update(`❌ 字段 "${question}" 填充失败`);
        }
    },

    /**
     * Executes a specific action (e.g., 'input', 'click') on a given element.
     * @param {HTMLElement} element - The target DOM element.
     * @param {string} action - The action to perform.
     * @param {string} value - The value for the action (if any).
     */
    async executeAction(element, action, value) {
        return new Promise(async (resolve, reject) => {
            try {
                if (action.toLowerCase().includes('click') || element.tagName === 'BUTTON' || element.type === 'button' || element.type === 'submit' || element.role === 'button') {
                    element.focus();
                    element.click();
                    // For clicks, especially on custom elements, we need to verify success
                    if (!await this.verifyClickSuccess(element)) {
                        console.warn("初步点击可能未成功，尝试模拟原生事件...");
                        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                        element.dispatchEvent(clickEvent);
                    }
                } else if (action.toLowerCase().includes('select') || element.tagName === 'SELECT') {
                    element.focus();
                    let optionFound = false;
                    // Try to find by value first
                    for (let opt of element.options) {
                        if (opt.value === value || opt.text.includes(value)) {
                            opt.selected = true;
                            optionFound = true;
                            break;
                        }
                    }
                    if (!optionFound) {
                         console.warn(`在 <select> 中未找到值 "${value}"`);
                    }
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                } else { // Default to input
                    element.focus();
                    element.value = value;
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                }
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    },

    /**
     * Verifies if a click action was successful, especially for custom UI elements.
     * @param {HTMLElement} element - The element that was clicked.
     * @returns {Promise<boolean>} - True if the click seemed successful.
     */
    async verifyClickSuccess(element) {
        // A simple heuristic: check if the element is still visible and enabled.
        // A more complex check could involve observing DOM mutations.
        return new Promise(resolve => {
            setTimeout(() => {
                const style = window.getComputedStyle(element);
                const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && element.offsetParent !== null;
                resolve(isVisible && !element.disabled);
            }, 500); // Wait a bit for UI to update
        });
    },

    /**
     * Asks the LLM to correct a failed field-filling attempt.
     * @param {object} originalField - The field that failed.
     * @param {Error} error - The error that occurred.
     * @param {object} profile - The user's profile.
     * @returns {Promise<object|null>} - A corrected field object or null.
     */
    async correctFieldWithLLM(originalField, error, profile) {
        console.log("[纠错模式] 准备向 LLM 请求修正方案...");
        let htmlContext = '';

        console.log(originalField);
        // 尝试用问题文本在整个body中定位上下文
        console.log('[纠错模式] 使用关联的HTML块或问题文本定位上下文。');
        if (originalField.question) {
            const bodyHtml = document.body.outerHTML;
            const idx = bodyHtml.indexOf(originalField.question);
            console.log(`问题文本 "${originalField.question}" 在body中索引位置: ${idx}`);
            if (idx !== -1) {
                const start = Math.max(0, idx - 2000);
                const end = Math.min(bodyHtml.length, idx + originalField.question.length + 2000);
                htmlContext = bodyHtml.substring(start, end);
                console.log('[纠错模式] 通过问题文本在body中定位到上下文，并截取问题文本上下2000字符。');
            }
        }

        if (!htmlContext) {
            try {
                const element = document.querySelector(originalField.selector);
                if (element) {
                    htmlContext = this.getSurroundingHtml(element);
                    console.log('[纠错模式] 使用选择器定位元素并获取其周边HTML作为上下文。');
                } else {
                    throw new Error('Element not found via selector');
                }
            } catch (e) {
                console.log(`[纠错模式] 无法通过选择器 \"${originalField.selector}\" 定位元素，且未找到关联的HTML块。将发送整个 body HTML 作为上下文。`);
                htmlContext = this.getVisibleHtml(); // Use the cleaned full HTML
            }
        }

        // Truncate context if it's too long
        if (htmlContext.length > 15000) {
            console.warn(`[纠错模式] HTML 上下文过长 (${htmlContext.length} chars)，将截断为 15000 字符。`);
            htmlContext = htmlContext.substring(0, 15000);
        }

        console.log("[纠错模式] 发送给LLM的HTML上下文:", htmlContext); // Log snippet

        const prompt = `
            你是一个Web自动化专家。一个自动化脚本在网页上填充字段时可能失败了。
            失败的字段信息:
            - 问题: \"${originalField.question}\"
            - 尝试的CSS选择器: \"${originalField.selector}\"
            - 字段类型: \"${originalField.action}\"

            这是该字段相关的HTML上下文:
            \`\`\`html
            ${htmlContext}
            \`\`\`

            用户个人资料如下:
            \`\`\`json
            ${JSON.stringify(profile, null, 2)}
            \`\`\`

            请分析HTML并提供一个修正方案。你需要返回一个JSON对象，其中包含一个JS能点击的CSS选择器。
            如果原始选择器是错误的，请提供 "newSelector"。
            如果字段是单选按钮或复选框，请确保选择器定位到用户资料匹配的特定选项。
            如果原始选择器其实是正确的，但可能因为时机问题或页面动态变化而失败，则返回原始选择器。
            如果原始选择器其实是正确的，并且也点击成功了，则返回空。

            返回格式必须是:
            {
              "newSelector": "<correct_css_selector>"
            }
        `;

        try {
            const response = await this.askLLM(prompt, 'gpt-4.1-turbo');
            const correctedJson = JSON.parse(response);
            console.log("[纠错模式] LLM返回的修正方案:", correctedJson);

            if (correctedJson && correctedJson.newSelector) {
                return { ...originalField, selector: correctedJson.newSelector };
            } else {
                console.error("[纠错模式] LLM未能提供有效的修正选择器。");
                return null;
            }
        } catch (e) {
            console.error("[纠错模式] 调用LLM进行纠错时发生严重错误:", e);
            return null;
        }
    },

    // --- DOM HELPER FUNCTIONS ---

    /**
     * Generates a unique CSS selector for a given element.
     * @param {HTMLElement} el - The element.
     * @returns {string} A unique selector.
     */
    getUniqueSelector(el) {
        if (!(el instanceof Element)) return;
        let path = [];
        while (el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.id) {
                selector += '#' + el.id;
                path.unshift(selector);
                break;
            } else {
                let sib = el, nth = 1;
                while (sib = sib.previousElementSibling) {
                    if (sib.nodeName.toLowerCase() == selector)
                       nth++;
                }
                if (nth != 1)
                    selector += ":nth-of-type("+nth+")";
            }
            path.unshift(selector);
            el = el.parentNode;
        }
        return path.join(" > ");
    },

    /**
     * Gets the HTML content surrounding a given element.
     * @param {HTMLElement} element - The element.
     * @param {number} radius - The character radius to search for.
     * @returns {string} The surrounding HTML.
     */
    getSurroundingHtml(element, radius = 2000) {
        let parent = element.parentElement;
        if (!parent) return element.outerHTML;

        // Go up to find a parent that contains a decent chunk of HTML
        while (parent && parent.outerHTML.length < radius && parent.tagName !== 'BODY') {
            element = parent;
            parent = parent.parentElement;
        }
        
        return element.outerHTML;
    },

    /**
     * Gets all visible HTML from the body.
     * @returns {string} The visible HTML.
     */
    getVisibleHtml() {
        // Clones the document body, removes script/style tags, and returns the outer HTML.
        const bodyClone = document.body.cloneNode(true);
        bodyClone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
        return bodyClone.outerHTML;
    }
};
