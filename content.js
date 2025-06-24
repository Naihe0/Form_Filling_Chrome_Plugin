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
                                        console.log(`[填充警告] LLM返回的选择器 \"${selector}\" 在待填充字段列表中未找到。将动态创建一个字段进行处理。`);
                                        
                                        // Attempt to find the original field from all extracted fields to get the HTML chunk
                                        const originalFieldFromAll = this.allFields.find(f => f.selector === selector);
                                        let chunk = originalFieldFromAll ? originalFieldFromAll.htmlChunk : null;

                                        // If chunk is still not found, try to find the most relevant chunk
                                        if (!chunk) {
                                            const tempElement = document.querySelector(selector);
                                            if (tempElement) {
                                                const tempHtml = tempElement.outerHTML;
                                                chunk = this.htmlChunks.find(c => c.includes(tempHtml)) || null;
                                            }
                                        }

                                        field = {
                                            selector: selector,
                                            action: (typeof value === 'boolean' && value === true) ? 'click' : 'fill',
                                            question: `(Inferred field for selector: ${selector})`,
                                            htmlChunk: chunk
                                        };
                                    }
                                    
                                    await this.processSingleField(field, value, userProfile);
                                }
                            }
                        } else {
                            console.log("所有已提取字段均已成功填充过。");
                        }
                    }
                    
                    if (this.isStopped) break;
                    
                    // page_has_changed = await this.navigateToNextPage();
                    console.log("单页填充模式：已完成当前页面，程序将终止。");
                    page_has_changed = false; // 在填充完一页后终止
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
            const prompt = `你是一个HTML解析专家。严格分析以下HTML片段，并仅返回此片段中存在的表单字段。输出一个纯JSON数组，其中每个对象代表一个字段。\n\n分块处理: 正在处理多个块中的第 ${chunkIndex} 块。\n\n每个字段对象必须包含:\n- 'question': 字段的文本标签或相关问题。\n- 'action': 从 'fill', 'click', 'select_by_text' 中选择一个操作。\n- 'selector': 用于与元素交互的、唯一的、有效的CSS选择器。\n- 'options': (仅当 action 为 'select_by_text' 或 'click' 时需要) 一个包含可用选项文本的数组。\n\n指南:\n1.  **文本输入 (Text, Date, Textarea)**: 使用 'action': 'fill'。'selector' 应直接指向 <input> 或 <textarea> 元素。\n2.  **单选/复选框 (Radio/Checkbox)**: 为 **每一个** 可点击的选项创建一个独立的对象。使用 'action': 'click'。'selector' 必须指向该选项的 <input> 元素。'question' 应该是这组选项共同的问题。'options' 应该是一个只包含这个特定选项标签文本的数组 (例如: ['是'] 或 ['篮球'])。\n3.  **下拉菜单 (Select)**: 使用 'action': 'select_by_text'。'selector' 应指向 <select> 元素或触发下拉菜单的点击目标。'options' 必须是所有可见选项文本的完整列表。\n4.  **严格性**: 只分析提供的HTML。不要猜测或包含HTML之外的字段。确保输出是纯粹的、格式正确的JSON数组，不包含任何解释性文本。\n\nHTML片段如下:\n\`\`\`html\n${html}\n\`\`\`\n`;

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

        async processSingleField(field, value, profile) {
            const { selector, action, question } = field;
            const MAX_RETRIES = 2; 
            let lastError = null;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                let element;
                try {
                    element = document.querySelector(selector);
                } catch (e) {
                    lastError = e;
                    console.warn(`Attempt ${attempt}/${MAX_RETRIES}: Invalid selector: \"${selector}\". Error: ${e.message}`);
                    // 如果选择器无效，重试也无济于事，直接退出循环
                    break; 
                }

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
            
            const correctedField = await this.correctFieldWithLLM(field, lastError, profile);
            
            if (correctedField) {
                console.log("[纠错模式] 获得修正建议，正在最后一次尝试:", correctedField);
                let element;
                try {
                    element = document.querySelector(correctedField.selector);
                } catch (e) {
                    console.error(`[纠错模式] 修正后的选择器 '${correctedField.selector}' 是无效的. Error: ${e.message}`);
                    element = null;
                }

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
                    console.error(`[纠错模式] 修正后的选择器 '${correctedField.selector}' 找不到元素或无效。`);
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

        getSurroundingHtml(element, radius = 2000) {
            let parent = element.parentElement;
            if (!parent) return element.outerHTML;

            // Go up to find a parent that contains a decent chunk of HTML
            while (parent && parent.outerHTML.length < radius && parent.tagName !== 'BODY') {
                element = parent;
                parent = parent.parentElement;
            }
            
            return element.outerHTML;
        }

        getVisibleHtml() {
            // Clones the document body, removes script/style tags, and returns the outer HTML.
            const bodyClone = document.body.cloneNode(true);
            bodyClone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
            return bodyClone.outerHTML;
        }

        async correctFieldWithLLM(originalField, error, profile) {
            console.log("[纠错模式] 准备向 LLM 请求修正方案...");
            let htmlContext = '';

            // 1. Try to use the HTML chunk associated with the field during extraction
            if (originalField.htmlChunk) {
                htmlContext = originalField.htmlChunk;
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
                    console.log(`[纠错模式] 无法通过选择器 \"${originalField.selector}\" 定位元素，且未找到关联的HTML块。将发送整个 body HTML 作为上下文。`);
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
                    - 问题: \"${originalField.question}\"
                    - 尝试的CSS选择器: \"${originalField.selector}\"
                    - 字段类型: \"${originalField.action}\\"

                    这是该字段相关的HTML上下文:
                    \`\`\`html
                    ${htmlContext}
                    \`\`\`

                    用户个人资料如下:
                    \`\`\`json
                    ${profile}
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

                const correction = await askLLM(correctionPrompt, 'gpt-4-turbo');

                console.log("[纠错模式] LLM返回的修正方案:", correction);

                if (correction && correction.newSelector) {
                    return { ...originalField, selector: correction.newSelector };
                } else {
                    console.error("[纠错模式] LLM未能提供有效的修正选择器。");
                    return null;
                }
            } catch (error) {
                console.error("[纠错模式] 调用LLM进行纠错时发生严重错误:", error);
                return null;
            }
        }
    }

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


