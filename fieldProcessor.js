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
    selectedModel: null,
    correctionEnabled: false, // 纠错开关状态

    /**
     * Initializes the FieldProcessor with necessary dependencies from the calling agent.
     * @param {object} agentContext - The context from the FormFillerAgent.
     * @param {StatusUI} agentContext.statusUI - The UI handler for status updates.
     * @param {Set<string>} agentContext.successfully_filled_fields - A set of selectors for already filled fields.
     * @param {function} agentContext.askLLM - The function to communicate with the LLM.
     * @param {string} agentContext.selectedModel - The model selected by the user.
     * @param {boolean} agentContext.correctionEnabled - The state of the correction toggle.
     */
    init(agentContext) {
        console.log("[fieldProcessor.js] Initializing with context:", agentContext);
        this.statusUI = agentContext.statusUI;
        this.successfully_filled_fields = agentContext.successfully_filled_fields;
        this.askLLM = agentContext.askLLM;
        this.selectedModel = agentContext.selectedModel;
        this.correctionEnabled = agentContext.correctionEnabled; // 保存状态
        console.log(`[fieldProcessor.js] Correction feature state set to: ${this.correctionEnabled}`);
    },

    /**
     * Processes a single field: finds the element, handles ambiguity, executes the action,
     * and retries with LLM correction on failure.
     * @param {object} field - The field object from the LLM.
     * @param {string} value - The value to fill in.
     * @param {object} profile - The user's profile data.
     * @param {number} correctionAttempt - Internal counter for retry attempts.
     */
    async processSingleField(field, value, profile, correctionAttempt = 0) {
        // ========================================================================
        // == REFACTORED LOGIC FOR HANDLING RADIO/CHECKBOX GROUPS              ==
        // ========================================================================
        if (Array.isArray(field.selector) && field.action.toLowerCase().includes('click') && field.options && value) {
            console.log(`[选项组处理] 检测到选项组字段: "${field.question}"，需要选择: "${value}"`);

            const valuesToSelect = Array.isArray(value) ? value : [value];
            let allSucceeded = true;
            let lastError = null;

            // --- First Pass: Attempt to fill all options directly --- 
            for (const singleValue of valuesToSelect) {
                const optionIndex = field.options.findIndex(opt => opt.includes(singleValue) || singleValue.includes(opt));

                if (optionIndex === -1) {
                    console.error(`[选项组处理] 在选项 [${field.options.join(', ')}] 中未找到值 "${singleValue}"。`);
                    allSucceeded = false;
                    lastError = new Error(`Option value "${singleValue}" not found in available options.`);
                    continue; 
                }

                const targetSelector = field.selector[optionIndex];
                if (!targetSelector) {
                    console.error(`[选项组处理] 索引 ${optionIndex} 在选择器数组中无效。`);
                    allSucceeded = false;
                    lastError = new Error(`Selector for option index ${optionIndex} is invalid.`);
                    continue;
                }

                console.log(`[选项组处理] 尝试点击: "${singleValue}" -> 选择器: "${targetSelector}"`);
                
                try {
                    const element = document.querySelector(targetSelector);
                    if (!element) {
                        throw new Error(`Element not found with selector: ${targetSelector}`);
                    }
                    
                    element.style.transition = 'all 0.3s';
                    element.style.border = '2px solid red';
                    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await new Promise(r => setTimeout(r, 100));

                    await this.executeAction(element, 'click', singleValue);
                    
                    element.style.border = '2px solid green';
                    this.successfully_filled_fields.add(this.getUniqueSelector(element));
                    console.log(`✅ [选项组处理] 成功点击: "${targetSelector}"`);

                } catch (e) {
                    console.error(`❌ [选项组处理] 点击选择器 "${targetSelector}" 时失败:`, e.message);
                    allSucceeded = false;
                    lastError = e; // Keep the last error for context
                }
            }

            // --- If any option failed, trigger LLM correction for the whole group --- 
            if (!allSucceeded) {
                const MAX_CORRECTION_RETRIES = 1; // 设置最大纠错重试次数
                if (correctionAttempt >= MAX_CORRECTION_RETRIES) {
                    console.error(`❌ [选项组处理] 字段 "${field.question}" 已达到最大纠错次数，最终失败。`);
                    this.statusUI.update(`❌ 字段 "${field.question}" 填充失败`);
                    return; // 停止重试
                }

                console.error(`[选项组处理] 字段 "${field.question}" 未能成功处理所有选项，将对整个组进行LLM纠错 (尝试 ${correctionAttempt + 1}/${MAX_CORRECTION_RETRIES})。`);
                this.statusUI.startTimer(`🤔 选项组填充失败，尝试纠错...`);
                
                // We pass the original field object, which contains all selectors and options.
                const fieldForCorrection = { ...field, value: valuesToSelect }; 

                try {
                    const correctedField = await this.correctFieldWithLLM(fieldForCorrection, lastError, profile);

                    if (correctedField && correctedField.selector && correctedField.action) {
                        this.statusUI.update(`✅ 纠错成功，正在重试字段 "${field.question}"...`);
                        console.log("[纠错后重试] 使用LLM修正后的新参数:", correctedField);
                        
                        // 使用修正后的数据递归调用，并增加重试计数器
                        await this.processSingleField(correctedField, correctedField.value || valuesToSelect, profile, correctionAttempt + 1);

                    } else {
                        throw new Error("LLM 纠错未能返回有效的修正方案。");
                    }
                } catch (correctionError) {
                    console.error(`❌ 字段 "${field.question}" 彻底失败，LLM 纠错也无效:`, correctionError.message);
                    this.statusUI.update(`❌ 字段 "${field.question}" 填充失败`);
                }
            }

            return; // Exit, as we have handled the group processing or correction.
        }
        // ========================================================================
        // == END OF REFACTORED LOGIC                                          ==
        // ========================================================================

        let { selector, action, question, value: fieldValue } = field; // value is now destructured
        const valueToFill = value || fieldValue; // Use value from args, fallback to field object's value
        const MAX_RETRIES = 2;
        let lastError = null;
        let elementToProcess = null;

        // --- Ambiguity Resolution ---
        try {
            const potentialElements = Array.from(document.querySelectorAll(selector));

            if (potentialElements.length > 1) {
                console.log(`[歧义处理] 选择器 "${selector}" 匹配到 ${potentialElements.length} 个元素。将通过问题文本 "${question}" 和答案 "${valueToFill}" 进行精确定位。`);
                
                const isClickAction = action.toLowerCase().includes('click');
                const normalize = str => (str || '').replace(/\s+/g, '').toLowerCase();

                if (isClickAction) {
                    // Click Action: First find the container by question, then the element by answer.
                    console.log(`[歧义处理] Click操作：将先用问题 "${question}" 定位范围，再用答案 "${valueToFill}" 寻找最佳匹配。`);
                    const normQuestion = normalize(question);
                    const normAnswer = normalize(valueToFill);

                    let bestContainer = null;
                    let minQuestionDistance = Infinity;

                    // Step 1: Find the best container element that is a common ancestor to the potential elements and is close to the question text.
                    for (const el of potentialElements) {
                        let parent = el.parentElement;
                        let distance = 1;
                        while (parent && distance < 10) {
                            const parentText = normalize(parent.textContent);
                            if (parentText.includes(normQuestion)) {
                                if (distance < minQuestionDistance) {
                                    minQuestionDistance = distance;
                                    bestContainer = parent;
                                }
                                break; // Found a good enough container for this element
                            }
                            parent = parent.parentElement;
                            distance++;
                        }
                    }

                    if (bestContainer) {
                        console.log(`[歧义处理] 已根据问题找到最佳容器。现在在容器内根据答案 "${valueToFill}" 寻找目标元素。`);
                        // Step 2: Inside the best container, find the element that best matches the answer.
                        const candidatesInContainer = Array.from(bestContainer.querySelectorAll(selector));
                        let bestElement = null;
                        let minAnswerDistance = Infinity;

                        for (const el of candidatesInContainer) {
                            const elText = normalize(el.textContent || el.innerText || el.value);
                            if (elText.includes(normAnswer)) {
                                bestElement = el;
                                minAnswerDistance = 0; // Direct match is the best
                                break; // Found the best possible match
                            }
                        }
                        elementToProcess = bestElement;
                    } else {
                        console.warn(`[歧义处理] 未能根据问题 "${question}" 找到一个清晰的父容器。`);
                    }

                } else {
                    // Fill Action: Find the element closest to the question label.
                    console.log(`[歧义处理] Fill操作：将使用问题 "${question}" 来寻找最佳匹配。`);
                    let minDistance = Infinity;
                    let bestElement = null;
                    let bestLabel = '';
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
                    elementToProcess = bestElement;
                    if(bestElement) {
                         console.log(`[歧义处理] 选择距离问题文本最近的元素 (匹配内容: "${bestLabel}")。`);
                    }
                }

                // Fallback if no element was selected through the logic above
                if (!elementToProcess) {
                    console.warn(`[歧义处理] 未能根据上下文找到明确的最佳匹配。将默认使用第一个可用的元素。`);
                    elementToProcess = potentialElements.find(el => !this.successfully_filled_fields.has(this.getUniqueSelector(el))) || null;
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
                await this.executeAction(element, action, valueToFill);
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
        
        this.statusUI.update(`🤔 填充失败，尝试纠错...`);
        const fieldForCorrection = { ...field, selector: selector, value: valueToFill }; // Pass value for context
        try {
            const correctedField = await this.correctFieldWithLLM(fieldForCorrection, lastError, profile);

            if (correctedField && correctedField.selector && correctedField.action) {
                this.statusUI.update(`✅ 纠错成功，正在重试字段 "${question}"...`);
                console.log("[纠错后重试] 使用LLM修正后的新参数:", correctedField);
                const finalElement = document.querySelector(correctedField.selector);
                if (finalElement) {
                    // Use the value from the corrected field, or the original value if not provided.
                    const finalValue = correctedField.value || valueToFill;
                    await this.executeAction(finalElement, correctedField.action, finalValue);
                    // Use the corrected selector for tracking success, get the unique one for robustness
                    const finalSelector = this.getUniqueSelector(finalElement);
                    this.successfully_filled_fields.add(finalSelector);
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
                        if (!await this.verifyClickSuccess(element)) {
                            console.error(`点击操作失败: ${element.tagName} (${element.className})`);
                            reject(new Error(`点击操作失败: ${element.tagName} (${element.className})`));
                        } else {
                            console.log(`✅ 点击操作成功: ${element.tagName} (${element.className})`);
                        }
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
        return new Promise(resolve => {
            setTimeout(() => {
                // Check 1: For native radio/checkbox, the 'checked' property is the source of truth.
                if ((element.type === 'radio' || element.type === 'checkbox')) {
                    if (element.checked) {
                        console.log('[VerifyClick] Success: Native checkbox/radio is checked.');
                        resolve(true);
                    } else {
                        console.warn('[VerifyClick] Failure: Native checkbox/radio is NOT checked.');
                        resolve(false);
                    }
                    return;
                }

                // Check 2: For ARIA custom controls, check aria-checked or aria-selected.
                if (element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-selected') === 'true') {
                    console.log('[VerifyClick] Success: ARIA state is checked/selected.');
                    resolve(true);
                    return;
                }

                // Check 3: If the element is no longer in the document, the click likely succeeded (e.g., a close button).
                if (!document.body.contains(element)) {
                    console.log('[VerifyClick] Success: Element was removed from DOM.');
                    resolve(true);
                    return;
                }

                // Check 4: If the element is now hidden, the click may have succeeded.
                const style = window.getComputedStyle(element);
                const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && element.offsetParent !== null;
                if (!isVisible) {
                    console.log('[VerifyClick] Success: Element is no longer visible.');
                    resolve(true);
                    return;
                }

                // Fallback: For other elements (like standard buttons that don't change state),
                // assume success if it's still enabled. This is an optimistic check.
                console.log('[VerifyClick] Fallback: Assuming success for visible, enabled element.');
                resolve(!element.disabled);

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
        console.log(`[fieldProcessor.js] correctFieldWithLLM called. Current correctionEnabled state: ${this.correctionEnabled}`);
        let htmlContext = '';
        const timeout = 30000; // 30 seconds timeout for LLM response
        // 如果纠错开关打开，则切换到更强的模型
        let modelForCorrection = this.selectedModel;
        if (this.correctionEnabled) {
            if (modelForCorrection.startsWith('deepseek')) {
                modelForCorrection = "deepseek-r1";
            } else if (modelForCorrection.startsWith('gemini')) {
                modelForCorrection = "gemini-2.5-pro";
            }
            timeout = 60000; // Increase timeout for correction to 60 seconds
            console.log(`[纠错模式] “推理纠错”已启用，临时切换到模型: ${modelForCorrection}`);
        }

        console.log(originalField);
        // 尝试用问题文本在整个body中定位上下文
        console.log('[纠错模式] 使用关联的HTML块或问题文本定位上下文。');
        if (originalField.question) {
            const bodyHtml = document.body.outerHTML;
            const idx = bodyHtml.indexOf(originalField.question);
            console.log(`问题文本 "${originalField.question}" 在body中索引位置: ${idx}`);
            if (idx !== -1) {
                const start = Math.max(0, idx - 1000);
                const end = Math.min(bodyHtml.length, idx + originalField.question.length + 3000);
                htmlContext = bodyHtml.substring(start, end);
                console.log('[纠错模式] 通过问题文本在body中定位到上下文，并截取问题文本上下4000字符。');
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

        const prompt = `
            你是一个Web自动化专家。一个自动化脚本在网页上填充字段时可能失败了。
            失败的字段信息:
            - 问题: \"${originalField.question}\"
            - 尝试的CSS选择器: \"${originalField.selector}\"
            - 如果是选择题，所有可选项：\"${originalField.options}\"
            - 字段类型: \"${originalField.action}\"
            - 期望填充/选择的值: \"${originalField.value || '(无特定值)'}\"

            这是该字段相关的HTML上下文:
            \`\`\`html
            ${htmlContext}
            \`\`\`

            用户个人资料如下:
            \`\`\`json
            ${JSON.stringify(profile, null, 2)}
            \`\`\`

            请分析HTML并提供一个修正方案。你需要返回一个JSON对象，其中包含修正后的字段信息。
            - 如果原始选择器是错误的，请提供新的、更精确的 \`newSelector\` 数组， 确保 \`newSelector\` 与 \`newOptions\` 对齐。
            - 如果是单选/复选框，确保 \`newSelector\` 定位到与 “期望填充的值” 匹配的具体 \`<input>\` 元素。
            - 如果 \`options\` 不正确 (例如, 选项组的实际选项与失败的字段信息不同), 请提供 \`newOptions\` 数组, 确保 \`newSelector\` 与 \`newOptions\` 对齐。
            - 如果 \`action\` 不正确 (例如, 应该用 \`click\` 而不是 \`input\`), 请提供 \`newAction\`。
            - 如果 \`value\` 不正确 (例如, 选择题但是不存在所有可选项中), 请提供 \`newValue\` 数组。
            - 如果原始选择器和操作都正确，但依然失败，你可以返回原始值，脚本会重试。
            - 如果你认为这个字段无法被修复或者其实点击/填充成功了，返回 \`{"error": "无法修复的原因"}\`。

            返回格式必须是:
            {
              \"newSelector\": \"[<correct_css_selector>]\",
              \"newOptions\": \"[<corrected_options>]\",
              \"newAction\": \"<input|click|select>\",
              \"newValue\": \"[<corrected_value>]\"
            }
        `;

        try {
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('LLM a timeout occurred during correction.')), timeout) // 30秒超时
            );

            // The askLLM function in content.js already parses the JSON string.
            // We receive an object here, so no need to parse it again.
            console.log("[纠错模式] Prompt内容:", prompt); // Log the prompt for debugging
            const correctedJson = await Promise.race([
                this.askLLM(prompt, modelForCorrection), // 使用指定的纠错模型
                timeoutPromise
            ]);
            console.log("[纠错模式] LLM返回的修正方案:", correctedJson);

            if (correctedJson && correctedJson.error) {
                console.error(`[纠错模式] LLM报告无法修复: ${correctedJson.error}`);
                return null;
            }

            if (correctedJson && correctedJson.newSelector) {
                return {
                    ...originalField,
                    selector: correctedJson.newSelector,
                    options: correctedJson.newOptions || originalField.options, // The options might also be corrected
                    action: correctedJson.newAction || originalField.action,
                    value: correctedJson.newValue || originalField.value // The value to fill might also be corrected
                };
            } else {
                console.warn("[纠错模式] LLM未能提供有效的修正选择器，将使用原始选择器重试。");
                return originalField; // Return original field to retry
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
