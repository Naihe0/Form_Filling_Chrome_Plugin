(async function() {
    console.log("智能表单填充助手：内容脚本已加载。");

    // --- Helper function to communicate with background script ---
    async function askLLM(prompt, model = 'gpt-4o') {
        const { apiKey } = await chrome.storage.local.get('apiKey');
        if (!apiKey) {
            alert("请先在插件弹窗中设置您的 OpenAI API Key。");
            throw new Error("API Key not found.");
        }
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { type: 'llm-request', payload: { prompt, apiKey, model } },
                (response) => {
                    if (response.success) {
                        try {
                            // The response might be a stringified JSON
                            resolve(JSON.parse(response.data));
                        } catch (e) {
                            // Or just a plain string
                            resolve(response.data);
                        }
                    } else {
                        reject(new Error(response.error));
                    }
                }
            );
        });
    }

    // --- Main Form Filling Logic ---
    class FormFillerAgent {
        constructor() {
            this.successfully_filled_fields = new Set();
            this.isStopped = false;
            this.stopButton = null;
            this.allFields = [];
            this.htmlChunks = []; // Store all HTML chunks
            this.filledFieldsCount = 0;
            this.totalFieldsToFill = 0;
        }

        createStopButton() {
            const button = document.createElement('button');
            button.id = 'stop-filling-button';
            button.textContent = '中断填充';
            Object.assign(button.style, {
                position: 'fixed',
                top: '20px',
                right: '20px',
                zIndex: '9999',
                padding: '10px 20px',
                backgroundColor: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
                fontSize: '16px',
                boxShadow: '0 2px 10px rgba(0,0,0,0.3)'
            });
            button.onclick = () => {
                this.isStopped = true;
                console.log("中断信号已接收。将在当前步骤完成后停止。");
                button.textContent = '正在中断...';
                button.disabled = true;
            };
            document.body.appendChild(button);
            this.stopButton = button;
        }

        removeStopButton() {
            if (this.stopButton) {
                this.stopButton.remove();
                this.stopButton = null;
            }
        }

        async start() {
            this.createStopButton();
            try {
                const { userProfile, apiKey } = await chrome.storage.local.get(['userProfile', 'apiKey']);
                if (!apiKey) {
                    alert("错误：未找到 OpenAI API Key。请在插件弹窗中设置。");
                    return;
                }
                if (!userProfile) {
                    alert("错误：未找到用户个人资料。请在插件弹窗中设置。");
                    return;
                }

                let page_has_changed = true;
                while(page_has_changed) {
                    if (this.isStopped) {
                        console.log("填充任务已被用户中断。");
                        break;
                    }
                    console.log("开始新一轮的字段提取与填充...");
                    const all_fields_on_page = await this.extractFields();

                    if (this.isStopped) break;

                    if (!all_fields_on_page || all_fields_on_page.length === 0) {
                        console.log("当前页面未找到可填充字段。");
                    } else {
                        const fields_to_fill = all_fields_on_page.filter(f => 
                            !this.successfully_filled_fields.has(f.selector)
                        );

                        if (fields_to_fill.length > 0) {
                            const filled_values = await this.generateFillValues(fields_to_fill, userProfile);
                            
                            if (this.isStopped) break;

                            for (const selector in filled_values) {
                                if (this.isStopped) break;
                                if (Object.prototype.hasOwnProperty.call(filled_values, selector)) {
                                    const value = filled_values[selector];
                                    if (value === undefined || value === null) continue;

                                    let field = fields_to_fill.find(f => f.selector === selector);

                                    if (!field) {
                                        const originalFieldFromAll = all_fields_on_page.find(f => f.selector === selector);
                                        console.log(`[填充警告] LLM返回的选择器 "${selector}" 在待填充字段列表中未找到。将动态创建一个字段进行处理。`);
                                        field = {
                                            selector: selector,
                                            action: (typeof value === 'boolean' && value === true) ? 'click' : 'fill',
                                            question: `(Inferred field for selector: ${selector})`,
                                            htmlChunk: originalFieldFromAll ? originalFieldFromAll.htmlChunk : null
                                        };
                                    }
                                    
                                    await this.processSingleField(field, value);
                                }
                            }
                        } else {
                            console.log("所有已提取字段均已成功填充过。");
                        }
                    }
                    
                    if (this.isStopped) break;
                    page_has_changed = await this.navigateToNextPage();
                }
                
                if (this.isStopped) {
                    alert("表单填充已由用户手动中断。");
                } else {
                    alert("表单填充完成！");
                }
            } catch (e) {
                console.error("表单填充过程中发生未捕获的错误:", e);
                alert("表单填充过程中发生错误，请查看控制台日志。");
            } finally {
                this.removeStopButton();
            }
        }

        // ========================================================================
        // == HYBRID FIELD EXTRACTION LOGIC                                    ==
        // ========================================================================

        async extractFields() {
            console.log("启动混合字段提取模式...");

            // --- Step 1: Attempt deterministic extraction first ---
            const deterministicFields = await this.extractFieldsDeterministically();
            console.log(`[混合模式] 确定性提取初步找到 ${deterministicFields.length} 个字段。`);

            // --- Step 2: Analyze the quality of the deterministic results ---
            const qualityThreshold = 0.7; 
            let goodLabels = 0;
            // [FIX] Expanded blacklist for meaningless, generic labels.
            const meaninglessLabels = ['请输入', '请选择', '请选择日期', '搜索', 'YYYY/MM/DD', 'Search for location', 'Round to 1 decimal place', '未找到标签'];

            for (const field of deterministicFields) {
                const question = field.question.trim();
                if (!question) continue;

                // Check 1: Is it a generic placeholder from our blacklist?
                if (meaninglessLabels.some(ml => question.includes(ml))) {
                    continue; // This is a low-quality label.
                }

                // Check 2: Is it a radio/checkbox option masquerading as a question?
                // These often have very short labels (e.g., '男', '女', '是', '否', '其他').
                if (field.action === 'click' && question.length <= 3) {
                    console.log(`[质量评估] 字段 "${question}" 被识别为可能的选项标签，而非问题。`);
                    continue; // This is a low-quality label.
                }
                
                goodLabels++;
            }

            const qualityScore = deterministicFields.length > 0 ? goodLabels / deterministicFields.length : 0;
            console.log(`[混合模式] 确定性提取质量评估: ${goodLabels}/${deterministicFields.length} (${(qualityScore * 100).toFixed(0)}%) 有效标签。`);

            // --- Step 3: Decide whether to fall back to LLM ---
            if (qualityScore < qualityThreshold && deterministicFields.length > 0) {
                console.warn(`[混合模式] 确定性提取质量低于阈值 (${qualityThreshold * 100}%)。正在切换到 LLM 提取模式...`);
                return this.extractFieldsWithLLM();
            } else {
                console.log("[混合模式] 确定性提取质量达标，将使用此结果。");
                return deterministicFields;
            }
        }

        // ========================================================================
        // == METHOD 1: LLM-BASED EXTRACTION (The Fallback)                    ==
        // ========================================================================

        async extractFieldsWithLLM() {
            console.log("[LLM模式] 开始使用 LLM 提取字段...");
            const formElement = document.querySelector('form') || document.body;
            const formHtml = formElement.outerHTML;

            const MAX_CHUNK_SIZE = 15000;
            const chunks = [];
            for (let i = 0; i < formHtml.length; i += MAX_CHUNK_SIZE) {
                chunks.push(formHtml.substring(i, i + MAX_CHUNK_SIZE));
            }

            console.log(`[LLM模式] HTML 被分为 ${chunks.length} 个块进行处理。`);

            const allFields = [];
            for (const [index, chunk] of chunks.entries()) {
                if (this.isStopped) {
                    console.log("[LLM模式] 字段提取被用户中断。");
                    return [];
                }
                console.log(`[LLM模式] 正在处理块 ${index + 1}/${chunks.length}...`);
                const result = await this.processHtmlChunkWithLLM(chunk, index + 1);
                if (result && Array.isArray(result)) {
                    const fieldsWithChunk = result.map(field => ({ ...field, htmlChunk: chunk }));
                    allFields.push(...fieldsWithChunk);
                }
                await new Promise(r => setTimeout(r, 500));
            }

            console.log(`[LLM模式] 所有块处理完毕，去重前共 ${allFields.length} 个字段。`);

            // Deduplicate fields based on selector
            const uniqueFields = [];
            const seenSelectors = new Set();
            for (const field of allFields) {
                if (field.selector && !seenSelectors.has(field.selector)) {
                    uniqueFields.push(field);
                    seenSelectors.add(field.selector);
                }
            }
            
            console.log(`[LLM模式] 总共提取到 ${uniqueFields.length} 个独立字段。`);
            return uniqueFields;
        }

        async processHtmlChunkWithLLM(html, chunkIndex) {
            const prompt = `你是一个HTML解析专家。严格分析以下HTML片段，并仅返回此片段中存在的表单字段。不要推断或包含HTML片段之外的任何字段。输出一个纯JSON数组，其中每个对象代表一个字段，包含'question', 'action', 'selector', 和 'options'。\n指南：\n- 'question': 必须是与字段关联的人类可读的标签文本。\n- 'action': 对文本输入使用'fill'，对复选框/单选按钮使用'click'，对下拉菜单使用'select_by_text'。\n- 'selector': 字段的唯一CSS选择器。\n- 'options': 对于下拉菜单或单选组，提供选项的可见文本列表。\n\nHTML片段如下：\n\n\`\`\`html\n${html}\n\`\`\``;

            try {
                console.log(`[LLM模式] Chunk #${chunkIndex} HTML to be processed (first 500 chars):\n`, html.substring(0, 500) + '...');
                let rawResponse = await askLLM(prompt, 'gpt-4o-mini');
                console.log(`[LLM模式] Chunk #${chunkIndex} Raw LLM Response:\n`, rawResponse);

                let extractedFields = rawResponse;
                if (typeof extractedFields === 'object' && extractedFields !== null && !Array.isArray(extractedFields)) {
                    const arrayKey = Object.keys(extractedFields).find(key => Array.isArray(extractedFields[key]));
                    if (arrayKey) {
                        extractedFields = extractedFields[arrayKey];
                    } else {
                        extractedFields = [extractedFields];
                    }
                }
                
                if (!Array.isArray(extractedFields)) {
                    console.warn(`[LLM模式] Chunk #${chunkIndex} 的 LLM 响应不是有效的数组，将返回空。`);
                    return [];
                }
                
                console.log(`[LLM模式] Chunk #${chunkIndex} 解析后的字段:`, extractedFields);
                return extractedFields;
            } catch (e) {
                console.error(`[LLM模式] 处理 HTML 块 #${chunkIndex} 时发生严重错误:`, e);
                return [];
            }
        }


        // ========================================================================
        // == METHOD 2: DETERMINISTIC EXTRACTION (The Primary)                 ==
        // ========================================================================

        getUniqueSelector(el) {
            if (!(el instanceof Element)) return;
            const path = [];
            while (el.nodeType === Node.ELEMENT_NODE) {
                let selector = el.nodeName.toLowerCase();
                if (el.id) {
                    selector = '#' + el.id;
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
        }

        async extractFieldsDeterministically() {
            console.log("[确定性模式] 开始使用确定性方法提取字段...");
            const formElements = Array.from(document.querySelectorAll('input, textarea, select'));
            const allFields = [];

            for (const element of formElements) {
                // 忽略用于操作的输入元素
                if (['hidden', 'submit', 'button', 'reset', 'image'].includes(element.type.toLowerCase())) {
                    continue;
                }

                const selector = this.getUniqueSelector(element);
                if (!selector) continue;

                // 1. 寻找标签
                let labelText = '';
                // a. 直接的 <label for="...">
                if (element.id) {
                    const labelFor = document.querySelector(`label[for='${element.id}']`);
                    if (labelFor) labelText = labelFor.innerText;
                }
                // b. 包裹型 <label>
                if (!labelText) {
                    const parentLabel = element.closest('label');
                    if (parentLabel) labelText = parentLabel.innerText;
                }
                // c. aria-label 或 aria-labelledby
                if (!labelText) {
                    labelText = element.getAttribute('aria-label');
                }
                if (!labelText) {
                    const labelledby = element.getAttribute('aria-labelledby');
                    if (labelledby) {
                        const labelElement = document.getElementById(labelledby);
                        if (labelElement) labelText = labelElement.innerText;
                    }
                }
                // d. 作为备选，寻找最近的父级元素的文本
                if (!labelText) {
                    let parent = element.parentElement;
                    let tries = 0;
                    while(parent && tries < 3) {
                        // 使用 .childNodes 来获取包括文本节点在内的所有子节点
                        const directText = Array.from(parent.childNodes)
                            .filter(node => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0)
                            .map(node => (node.textContent || '').trim())
                            .join(' ');

                        if (directText) {
                            labelText = directText;
                            break;
                        }
                        parent = parent.parentElement;
                        tries++;
                    }
                }
                 // e. 使用 placeholder 作为最后的备选
                if (!labelText && element.placeholder) {
                    labelText = element.placeholder;
                }


                const field = {
                    question: (labelText || '').trim().replace(/\s+/g, ' ') || element.name || '未找到标签',
                    action: '',
                    selector: selector,
                    options: []
                };

                // 2. 确定操作和选项
                const tagName = element.tagName.toLowerCase();
                const type = element.type.toLowerCase();

                if (tagName === 'select') {
                    field.action = 'select_by_text';
                    field.options = Array.from(element.options).map(opt => (opt.text || '').trim()).filter(t => t);
                } else if (type === 'checkbox' || type === 'radio') {
                    field.action = 'click';
                } else {
                    field.action = 'fill';
                }

                allFields.push(field);
            }
            
            console.log(`[确定性模式] 找到 ${allFields.length} 个字段。`, allFields);
            return allFields;
        }

        async generateFillValues(fields, profile) {
            const prompt = `你是智能表单填充助手。根据用户资料，为给定的表单字段生成需要填写的确切值。请以纯 JSON 对象的格式返回结果，键是字段的 CSS selector，值是待填充的内容。\n\n--- 用户资料 ---\n${profile}\n\n--- 表单字段 (JSON 格式) ---\n${JSON.stringify(fields, null, 2)}\n\n--- 填充规则 ---\n1. 仔细匹配 'question' 和 'action'。\n2. 对于 'select_by_text'，从 'options' 列表中选择最匹配的项。\n3. 对于值为布尔值true的'click'操作，表示应选中该单选按钮或复选框。\n4. 如果资料中无匹配信息，不要包含该字段。\n5. 只输出 JSON。\n\n--- 输出 (纯 JSON) ---`;
            
            try {
                const values = await askLLM(prompt, 'gpt-4.1-mini');
                console.log("LLM 生成的填充值:", values);
                return values;
            } catch (e) {
                console.error("生成填充值时出错:", e);
                return {};
            }
        }

        async processSingleField(field, value) {
            const { selector, action, question } = field;
            const MAX_RETRIES = 2; 
            let lastError = null;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                const element = document.querySelector(selector);

                if (!element) {
                    lastError = new Error(`Element not found with selector: ${selector}`);
                    console.warn(`Attempt ${attempt}/${MAX_RETRIES}: ${lastError.message} (Question: ${question})`);
                    await new Promise(r => setTimeout(r, 500 * attempt));
                    continue;
                }

                element.style.transition = 'all 0.3s';
                element.style.border = '2px solid red';
                element.style.backgroundColor = '#fff0f0';
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });

                await new Promise(r => setTimeout(r, 300));

                try {
                    await this.executeAction(element, action, value);
                    console.log(`成功 (尝试 ${attempt}): Action '${action}' on '${question}' with value '${value}'`);
                    element.style.border = '2px solid green';
                    element.style.backgroundColor = '#f0fff0';
                    this.successfully_filled_fields.add(selector);
                    
                    await new Promise(r => setTimeout(r, 500)); 
                    element.style.border = '';
                    element.style.backgroundColor = '';
                    return; 

                } catch (e) {
                    lastError = e;
                    console.warn(`失败 (尝试 ${attempt}/${MAX_RETRIES}): Action '${action}' on '${question}'. Error:`, e);
                    element.style.border = '2px solid orange';
                    if (attempt < MAX_RETRIES) {
                        await new Promise(r => setTimeout(r, 500 * attempt));
                    }
                }
            }
            
            console.error(`常规尝试最终失败: Action '${action}' on '${question}'. 正在调用 LLM 进行纠错...`);
            
            const correctedField = await this.correctFieldWithLLM(field, lastError);
            
            if (correctedField) {
                console.log("[纠错模式] 获得修正建议，正在最后一次尝试:", correctedField);
                const element = document.querySelector(correctedField.selector);
                if (element) {
                    try {
                        element.style.border = '2px solid blue';
                        element.style.backgroundColor = '#f0f8ff';
                        await this.executeAction(element, correctedField.action, value);
                        console.log(`成功 (纠错后): Action '${correctedField.action}' on '${correctedField.question}' with value '${value}'`);
                        element.style.border = '2px solid green';
                        element.style.backgroundColor = '#f0fff0';
                        this.successfully_filled_fields.add(correctedField.selector);
                        
                        await new Promise(r => setTimeout(r, 500));
                        element.style.border = '';
                        element.style.backgroundColor = '';
                        return;
                    } catch (e) {
                        console.error(`最终失败 (纠错后): Action '${correctedField.action}' on '${correctedField.question}'. Error:`, e);
                    }
                } else {
                    console.error(`[纠错模式] 修正后的选择器 '${correctedField.selector}' 仍然找不到元素。`);
                }
            } else {
                console.error(`[纠错模式] LLM 未能提供修正建议。彻底放弃字段 '${question}'。`);
            }
        }

        async executeAction(element, action, value) {
            switch (action) {
                case 'fill':
                    if (typeof value !== 'boolean') {
                        element.value = value;
                        element.dispatchEvent(new Event('input', { bubbles: true }));
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    break;
                case 'click':
                    if (value === true) {
                        element.click();
                    }
                    break;
                case 'select_by_text':
                    const option = Array.from(element.options).find(opt => opt.text.trim() === value.trim());
                    if (option) {
                        element.value = option.value;
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                    } else {
                        element.click();
                        await new Promise(r => setTimeout(r, 300));
                        const textOption = Array.from(document.querySelectorAll('li, [role="option"]')).find(el => el.textContent.trim() === value.trim());
                        if (textOption) {
                            textOption.click();
                        } else {
                            throw new Error(`在下拉菜单中找不到选项: "${value}"`);
                        }
                    }
                    break;
                default:
                    throw new Error(`未知的操作类型: '${action}'`);
            }
        }

        async correctFieldWithLLM(originalField, error) {
            console.log("[纠错模式] 准备向 LLM 请求修正方案...");
            let htmlContext = '';

            // 1. Try to use the HTML chunk associated with the field during extraction
            if (originalField.chunk) {
                htmlContext = originalField.chunk;
                console.log('[纠错模式] 使用字段关联的HTML块作为上下文。');
            } 
            // 2. If no chunk, try to find the relevant chunk using the question text
            else if (originalField.question) {
                const foundChunk = this.htmlChunks.find(chunk => chunk.includes(originalField.question));
                if (foundChunk) {
                    htmlContext = foundChunk;
                    console.log('[纠错模式] 通过问题文本定位到相关HTML块作为上下文。');
                }
            }

            // 3. Fallback if context is still not found
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
                    console.log(`[纠错模式] 无法通过选择器 "${originalField.selector}" 定位元素，且未找到关联的HTML块。将发送整个 body HTML 作为上下文。`);
                    htmlContext = this.getVisibleHtml(); // Use the cleaned full HTML
                }
            }

            // Truncate context if it's too long
            if (htmlContext.length > 15000) {
                console.warn(`[纠错模式] HTML 上下文过长 (${htmlContext.length} chars)，将截断为 15000 字符。`);
                htmlContext = htmlContext.substring(0, 15000);
            }

            console.log("[纠错模式] 发送给LLM的HTML上下文:", htmlContext.substring(0, 200) + "..."); // Log snippet

            try {
                const correctionPrompt = `
                    你是一个Web自动化专家。一个自动化脚本在网页上填充字段时失败了。
                    失败的字段信息:
                    - 问题: "${originalField.question}"
                    - 尝试的CSS选择器: "${originalField.selector}"
                    - 字段类型: "${originalField.type}"

                    这是该字段相关的HTML上下文:
                    \`\`\`html
                    ${htmlContext}
                    \`\`\`

                    用户个人资料如下:
                    \`\`\`json
                    ${JSON.stringify(profile)}
                    \`\`\`

                    请分析HTML并提供一个修正方案。你需要返回一个JSON对象，其中包含一个新的、更健壮的CSS选择器。
                    如果原始选择器是错误的，请提供 "newSelector"。
                    如果字段是单选按钮或复选框，请确保选择器定位到用户资料匹配的特定选项。
                    如果原始选择器看起来是正确的，但可能因为时机问题或页面动态变化而失败，则返回原始选择器。

                    返回格式必须是:
                    {
                      "newSelector": "<correct_css_selector>"
                    }
                `;

                const response = await callLlmApi({
                    model: 'gpt-4-turbo', // Use a powerful model for correction
                    messages: [
                        { role: 'system', content: 'You are an expert web automation troubleshooter.' },
                        { role: 'user', content: correctionPrompt }
                    ],
                    response_format: { type: "json_object" }
                });

                const correction = JSON.parse(response.choices[0].message.content.trim());
                console.log("[纠错模式] LLM返回的修正方案:", correction);

                if (correction.newSelector) {
                    // Create a new field object with the corrected selector to try again
                    const correctedField = { ...originalField, selector: correction.newSelector };
                    // Call processSingleField again, but with only 1 retry and no further correction loop
                    updateStatus(`收到修正方案，正在重试填充 "${originalField.question}"...`);
                    // Directly try to fill, without the retry loop of processSingleField
                    return await tryFillingWithCorrection(correctedField, profile);
                } else {
                    console.error("[纠错模式] LLM未能提供有效的修正选择器。");
                    return false;
                }
            } catch (error) {
                console.error("[纠错模式] 调用LLM进行纠错时发生严重错误:", error);
                return false;
            }
        }
    }

    // =================================================================================================
    // 2. HTML 解析和分块 (HTML Parsing and Chunking)
    // =================================================================================================

    /**
     * Splits the HTML content by semantic blocks like <form> or large containers.
     * Falls back to character-based splitting if no clear structure is found.
     * @returns {string[]} An array of HTML chunks.
     */
    function getSmartHtmlChunks() {
        console.log("使用智能分块逻辑分割HTML...");
        const body = document.body;
        if (!body) return [];

        // Strategy 1: Split by <form> elements
        const forms = Array.from(body.querySelectorAll('form'));
        if (forms.length > 0) {
            console.log(`发现 ${forms.length} 个 <form> 元素，将作为HTML块。`);
            return forms.map(form => form.outerHTML);
        }

        // Strategy 2: Split by large container elements with multiple form controls
        const containers = [];
        const allPotentialContainers = body.querySelectorAll('div, section, article');
        allPotentialContainers.forEach(container => {
            // Ignore small containers or those nested deep inside another chosen container
            if (container.innerHTML.length < 500 || containers.some(c => c.contains(container))) {
                return;
            }
            const inputs = container.querySelectorAll('input, textarea, select, button');
            if (inputs.length > 2) { // Heuristic: a container with more than 2 inputs is a "group"
                containers.push(container);
            }
        });

        if (containers.length > 0) {
            console.log(`未找到 <form>，但发现 ${containers.length} 个包含表单控件的容器，将作为HTML块。`);
            return containers.map(container => container.outerHTML);
        }

        // Fallback Strategy: Split by character limit
        console.log("未找到 <form> 或合适的容器，将退回至按字符数分割。");
        const fullHtml = body.outerHTML;
        const chunkSize = 15000;
        const chunks = [];
        for (let i = 0; i < fullHtml.length; i += chunkSize) {
            chunks.push(fullHtml.substring(i, i + chunkSize));
        }
        console.log(`HTML已按 ${chunkSize} 字符分割成 ${chunks.length} 个块。`);
        return chunks;
    }


    /**
     * Extracts form fields from the provided HTML chunks.
     * @param {string[]} htmlChunks - An array of HTML strings to parse.
     * @returns {Promise<object[]>} A promise that resolves to an array of field objects.
     */
    async function extractFieldsFromHtml(htmlChunks) {
        updateStatus(`正在解析 ${htmlChunks.length} 个HTML块以提取字段...`);

        const promises = htmlChunks.map(async (chunk, index) => {
            try {
                const response = await callLlmApi({
                    model: 'gpt-4o-mini', // Use a faster model for parsing
                    messages: [
                        {
                            role: 'system',
                            content: `你是一个HTML解析助手。你的任务是从给定的HTML代码段中识别并提取出所有的表单字段(input, textarea, select, radio, checkbox)以及提交按钮。
                            你需要为每个字段提取以下信息：
                            1.  "question": 与字段关联的标签或问题文本。如果找不到，就根据字段的 'name' 或 'id' 属性生成一个描述性问题。
                            2.  "type": 字段的类型 (例如, 'text', 'password', 'radio', 'checkbox', 'select-one', 'textarea', 'submit')。
                            3.  "selector": 一个精确的CSS选择器，可以唯一地定位到该HTML元素。优先使用ID，其次是name和value的组合，确保选择器的鲁棒性。对于单选和复选框，选择器必须包含value属性。
                            4.  "options" (可选): 对于 'select', 'radio', 或 'checkbox' 类型的字段，提供所有可选值的列表。
                            5.  "value": 字段的当前值。

                            请以JSON格式返回一个包含所有提取字段的数组。每个字段都是一个对象。确保JSON格式正确无误。
                            例如:
                            [
                              { "question": "您的姓名", "type": "text", "selector": "#username", "value": "" },
                              { "question": "性别", "type": "radio", "selector": "input[name='gender'][value='male']", "options": ["male", "female"] }
                            ]
                            `
                        },
                        { role: 'user', content: chunk }
                    ]
                });
                const resultText = response.choices[0].message.content.trim();
                const jsonResult = JSON.parse(resultText);
                // Add the source html chunk to each field for later reference
                jsonResult.forEach(field => {
                    field.htmlChunk = chunk;
                    field.chunkIndex = index;
                });
                return jsonResult;
            } catch (error) {
                console.error(`解析HTML块 ${index + 1} 时出错:`, error);
                updateStatus(`解析HTML块 ${index + 1} 失败。`);
                return []; // Return empty array on error
            }
        });

        const results = await Promise.all(promises);
        return results.flat(); // Flatten the array of arrays
    }


    // =================================================================================================
    // 4. 主流程控制 (Main Flow Control)
    // =================================================================================================

    async function start(profile) {
        if (stopFilling) {
            console.log("填充过程已被用户停止。");
            updateStatus("已停止。");
            return;
        }

        console.log("开始表单填充流程...", profile);
        updateStatus("正在初始化...");

        // 1. Get HTML chunks
        allHtmlChunks = getSmartHtmlChunks();
        if (allHtmlChunks.length === 0) {
            updateStatus("错误：无法获取页面HTML内容。");
            console.error("无法获取HTML块，终止流程。");
            return;
        }

        // 2. Extract fields from HTML
        fields = await extractFieldsFromHtml(allHtmlChunks);
        console.log("提取到的所有字段:", fields);

        // 3. Filter out fields that are already successfully filled
        const fieldsToFill = fields.filter(field => !this.successfully_filled_fields.has(field.selector));
        this.totalFieldsToFill = fieldsToFill.length;
        console.log(`待填充字段总数: ${this.totalFieldsToFill}`);

        if (fieldsToFill.length === 0) {
            updateStatus("所有字段均已填充过。");
            alert("所有字段均已填充过。");
            return;
        }

        // 4. Start filling process
        updateStatus(`即将开始填充 ${fieldsToFill.length} 个字段...`);
        for (const field of fieldsToFill) {
            if (this.isStopped) break;
            await this.processSingleField(field, profile);
        }

        if (this.isStopped) {
            alert("表单填充已由用户手动中断。");
        } else {
            alert("表单填充完成！");
        }
    }

    // =================================================================================================
    // 6. UI 和消息监听 (UI and Message Listening)
    // =================================================================================================

    function updateStatus(message) {
        const statusElement = document.getElementById('form-filler-status');
        if (statusElement) {
            statusElement.textContent = message;
        } else {
            console.log("状态更新:", message);
        }
    }

    // Initial UI setup
    (function initUI() {
        const statusDiv = document.createElement('div');
        statusDiv.id = 'form-filler-status';
        statusDiv.style.position = 'fixed';
        statusDiv.style.bottom = '10px';
        statusDiv.style.right = '10px';
        statusDiv.style.zIndex = '9999';
        statusDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        statusDiv.style.color = 'white';
        statusDiv.style.padding = '10px 15px';
        statusDiv.style.borderRadius = '5px';
        statusDiv.style.fontSize = '14px';
        statusDiv.style.maxWidth = '300px';
        statusDiv.style.wordWrap = 'break-word';
        document.body.appendChild(statusDiv);
    })();

    // Listen for messages from the background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'start-filling') {
            const profile = request.payload;
            agent.start(profile);
        } else if (request.type === 'stop-filling') {
            agent.isStopped = true;
            updateStatus("填充已中断。");
        }
    });

    const agent = new FormFillerAgent();
    agent.start();
})();


