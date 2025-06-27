(async function() {
    console.log("智能表单填充助手：内容脚本已加载。");

    // --- Helper function to communicate with background script ---
    async function askLLM(prompt, model = 'gpt-4.1') {
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

    // ========================================================================
    // == VISUAL FEEDBACK UI                                               ==
    // ========================================================================
    class StatusUI {
        constructor() {
            this.overlay = null;
            this.statusTextElement = null;
            this.init();
        }

        init() {
            // Avoid creating multiple overlays
            if (document.getElementById('form-filler-overlay')) return;

            this.overlay = document.createElement('div');
            this.overlay.id = 'form-filler-overlay';
            Object.assign(this.overlay.style, {
                position: 'fixed',
                bottom: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: '10000',
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                color: 'white',
                padding: '15px 25px',
                borderRadius: '10px',
                boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                gap: '15px',
                fontFamily: 'sans-serif',
                fontSize: '16px',
                transition: 'opacity 0.5s, bottom 0.5s',
                opacity: '1'
            });

            this.statusTextElement = document.createElement('span');
            this.overlay.appendChild(this.statusTextElement);
            
            document.body.appendChild(this.overlay);
        }

        update(message) {
            if (!this.overlay || this.overlay.style.opacity === '0') {
                this.init();
            }
            this.statusTextElement.textContent = message;
            console.log("Status Update:", message);
        }

        remove() {
            if (this.overlay) {
                this.overlay.style.opacity = '0';
                this.overlay.style.bottom = '-100px';
                setTimeout(() => {
                    if (this.overlay) {
                        this.overlay.remove();
                        this.overlay = null;
                    }
                }, 500);
            }
        }
    }


    // --- Main Form Filling Logic ---
    class FormFillerAgent {
        constructor() {
            this.successfully_filled_fields = new Set();
            this.isStopped = false;
            this.allFields = [];
            this.htmlChunks = []; // Store all HTML chunks
            this.filledFieldsCount = 0;
            this.totalFieldsToFill = 0;
            this.statusUI = new StatusUI();
        }

        async start(payload) {
            this.statusUI.update("🚀 开始填充表单...");
            try {
                const { userProfile, apiKey } = payload;
                if (!apiKey) {
                    alert("错误：未找到 OpenAI API Key。请在插件弹窗中设置。");
                    this.statusUI.update("❌ 未找到 API Key");
                    return;
                }
                if (!userProfile) {
                    alert("错误：未找到用户个人资料。请在插件弹窗中设置。");
                    this.statusUI.update("❌ 未找到用户资料");
                    return;
                }

                let page_has_changed = true;
                while(page_has_changed) {
                    if (this.isStopped) {
                        console.log("填充任务已被用户中断。");
                        break;
                    }
                    console.log("开始新一轮的字段提取与填充...");
                    this.statusUI.update("🔍 正在提取页面字段...");
                    const all_fields_on_page = await this.extractFields();

                    if (this.isStopped) break;

                    if (!all_fields_on_page || all_fields_on_page.length === 0) {
                        console.log("当前页面未找到可填充字段。");
                        this.statusUI.update("🤔 未找到可填充字段。");
                    } else {
                        const fields_to_fill = all_fields_on_page.filter(f => 
                            !this.successfully_filled_fields.has(f.selector)
                        );

                        if (fields_to_fill.length > 0) {
                            this.statusUI.update(`🧠 正在请求LLM为 ${fields_to_fill.length} 个字段分析填充值...`);
                            const fields_with_values = await this.addValuesToFields(fields_to_fill, userProfile);

                            if (this.isStopped) break;

                            let filledCount = 0;
                            for (const field of fields_with_values) {
                                if (this.isStopped) break;
                                
                                // Check if the LLM provided a value for this field
                                if (field.value !== undefined && field.value !== null) {
                                    filledCount++;
                                    this.statusUI.update(`✍️ 正在填充 (${filledCount}/${fields_to_fill.length}): ${field.question}`);
                                    await this.processSingleField(field, field.value, userProfile);
                                }
                            }
                        } else {
                            console.log("所有已提取字段均已成功填充过。");
                            this.statusUI.update("👍 所有字段均已填充。");
                        }
                    }
                    
                    if (this.isStopped) break;
                    
                    // page_has_changed = await this.navigateToNextPage();
                    console.log("单页填充模式：已完成当前页面，程序将终止。");
                    page_has_changed = false; // 在填充完一页后终止
                }
                
                if (this.isStopped) {
                    // alert("表单填充已由用户手动中断。"); // Alert is handled by popup
                    this.statusUI.update("🛑 填充已中断。");
                } else {
                    alert("表单填充完成！");
                    this.statusUI.update("✅ 表单填充完成！");
                }
            } catch (e) {
                console.error("表单填充过程中发生未捕获的错误:", e);
                alert("表单填充过程中发生错误，请查看控制台日志。");
                this.statusUI.update("❌ 发生错误，请查看控制台。");
            } finally {
                // this.removeStopButton(); // Removed
                setTimeout(() => this.statusUI.remove(), 3000);
            }
        }

        // ========================================================================
        // == LLM-BASED FIELD EXTRACTION LOGIC                                 ==
        // ========================================================================

        async extractFields() {
            console.log("启动LLM字段提取模式...");
            return this.extractFieldsWithLLM();
        }

        // ========================================================================
        // == LLM-BASED EXTRACTION                                             ==
        // ========================================================================

        async extractFieldsWithLLM() {
            console.log("[LLM模式] 开始使用 LLM 提取字段...");
            // const formElement = document.querySelector('form') || document.body;
            const formElement = document.body;
            
            // --- New intelligent chunking logic ---
            const formClone = formElement.cloneNode(true);
            // Remove irrelevant tags to reduce noise and token count
            formClone.querySelectorAll('script, style, noscript, svg, footer, nav').forEach(el => el.remove());

            const MAX_CHUNK_SIZE = 15000; // Keep the size limit
            const chunks = [];
            let currentChunkHtml = '';

            // Find the most relevant container of fields, often a form is wrapped in a single div
            let parentContainer = formClone;
            if (formClone.children.length === 1 && formClone.children[0].children.length > 1) {
                 parentContainer = formClone.children[0];
            }

            const elementsToChunk = Array.from(parentContainer.children);

            for (const element of elementsToChunk) {
                const elementHtml = element.outerHTML;
                if (!elementHtml) continue;

                // If adding the next element exceeds the chunk size, push the current chunk.
                if (currentChunkHtml.length + elementHtml.length > MAX_CHUNK_SIZE && currentChunkHtml.length > 0) {
                    chunks.push(currentChunkHtml);
                    currentChunkHtml = '';
                }

                // Add the element's HTML to the current chunk.
                currentChunkHtml += elementHtml + '\n';
            }

            // Add the last remaining chunk if it's not empty.
            if (currentChunkHtml.length > 0) {
                chunks.push(currentChunkHtml);
            }
            // --- End of new chunking logic ---

            console.log(`[LLM模式] HTML 被智能地分为 ${chunks.length} 个块进行处理。`);

            const allFields = [];
            for (const [index, chunk] of chunks.entries()) {
                if (this.isStopped) {
                    console.log("[LLM模式] 字段提取被用户中断。");
                    return [];
                }
                console.log(`[LLM模式] 正在处理块 ${index + 1}/${chunks.length}...`);
                const result = await this.processHtmlChunkWithLLM(chunk, index + 1);
                if (result && Array.isArray(result)) {
                    // Associate the chunk with the fields extracted from it.
                    const fieldsWithChunk = result.map(field => ({ ...field, htmlChunk: chunk }));
                    allFields.push(...fieldsWithChunk);
                }
                await new Promise(r => setTimeout(r, 500)); // Rate limiting
            }

            console.log(`[LLM模式] 所有块处理完毕，去重前共 ${allFields.length} 个字段。`);

            // Deduplicate fields based on a combination of question and selector to avoid removing fields with generic selectors but different labels.
            const uniqueFields = [];
            const seenFields = new Set();
            for (const field of allFields) {
                if (field.selector) {
                    // Create a unique key from the question and selector.
                    const fieldKey = `${field.question}|${field.selector}`;
                    if (!seenFields.has(fieldKey)) {
                        uniqueFields.push(field);
                        seenFields.add(fieldKey);
                    }
                }
            }
            
            console.log(`[LLM模式] 总共提取到 ${uniqueFields.length} 个独立字段。`);
            this.allFields = uniqueFields; // Store all fields for later reference
            this.htmlChunks = chunks; // Store all chunks for correction context
            return uniqueFields;
        }

        async processHtmlChunkWithLLM(html, chunkIndex) {
            const prompt = `你是一个HTML解析专家。严格分析以下网页问卷的HTML片段，并仅返回此片段中存在的表单字段。输出一个纯JSON数组，其中每个对象代表一个字段。\n\n分块处理: 正在处理多个块中的第 ${chunkIndex} 块。\n\n每个字段对象必须包含:\n- 'question': 字段的文本标签或相关问题。\n- 'action': 从 'fill', 'click', 'select_by_text' 中选择一个操作。\n- 'selector': 用于与元素交互的、唯一的、有效的CSS选择器。\n- 'options': (仅当 action 为 'select_by_text' 或 'click' 时需要) 一个包含可用选项文本的数组。\n\n指南:\n1.  **文本输入 (Text, Date, Textarea)**: 使用 'action': 'fill'。'selector' 应直接指向 <input> 或 <textarea> 元素。\n2.  **单选/复选框 (Radio/Checkbox)**: 为 **每一个** 可点击的选项创建一个独立的对象。使用 'action': 'click'。'selector' 必须指向该选项的 <input> 元素。'question' 应该是这组选项共同的问题。'options' 应该是一个只包含这个特定选项标签文本的数组 (例如: ['是'] 或 ['篮球'])。\n3.  **下拉菜单 (Select)**: 使用 'action': 'select_by_text'。'selector' 应指向 <select> 元素或触发下拉菜单的点击目标。'options' 必须是所有可见选项文本的完整列表。\n4.  **严格性**: 只分析提供的HTML。不要猜测或包含HTML之外的字段。确保输出是纯粹的、格式正确的JSON数组，不包含任何解释性文本。\n\nHTML片段如下:\n\`\`\`html\n${html}\n\`\`\`\n`;

            try {
                console.log(`[LLM模式] Chunk #${chunkIndex} HTML to be processed (first 500 chars):\n`, html.substring(0, 500) + '...');
                let rawResponse = await askLLM(prompt, 'gpt-4.1-mini');
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

        async addValuesToFields(fields, profile) {
            // Create a version of the fields array without htmlChunk and with a temporary ID
            const fieldsForPrompt = fields.map(({ htmlChunk, ...rest }, index) => ({
                ...rest,
                _id: index // Add a temporary ID
            }));

            console.log("发送给LLM用于添加填充值的字段:", JSON.stringify(fieldsForPrompt, null, 2));
            const prompt = `你是一个智能表单填充与修正助手。根据提供的用户资料，分析下面的JSON字段数组。你的任务是：\n1.  为每个可以填充的字段添加一个 'value' 键。\n2.  (可选) 如果发现字段的 'selector' 或 'options' 不正确或不完整，请修正它们。\n3.  **重要**: 你必须在返回的每个对象中保留原始的 '_id' 字段。\n\n--- 用户资料 ---\n${profile}\n\n--- 表单字段 (JSON数组) ---\n${JSON.stringify(fieldsForPrompt, null, 2)}\n\n--- 填充与修正规则 ---\n-   **分析**: 仔细分析每个字段对象的 'question', 'action', 'selector', 和 'options'。\n-   **填充 'value'**: 根据用户资料确定最匹配的填充值。\n    -   对于 'click' 操作，如果应该点击，'value' 设为布尔值 \\\`true\\\`。\n    -   对于 'select_by_text' 操作，'value' 必须是 'options' 数组中完全匹配的字符串。\n    -   如果找不到对应信息，则 **不要** 添加 'value' 键。\n-   **修正**: 如果你认为 'selector' 不够健壮或 'options' 列表不完整，你可以更新它们。\n-   **输出**: 你 **必须** 返回完整的、被修改后的JSON数组。数组中的对象必须包含原始的 '_id'。输出必须是纯粹的JSON数组。\n\n--- 输出 (修改后的JSON数组) ---`;
            
            try {
                let updatedFieldsFromLLM = await askLLM(prompt, 'gpt-4.1-mini');
                console.log("LLM 返回的带填充值的字段:", updatedFieldsFromLLM);
                
                // Handle cases where LLM wraps the array in an object (e.g., { "result": [...] })
                if (typeof updatedFieldsFromLLM === 'object' && updatedFieldsFromLLM !== null && !Array.isArray(updatedFieldsFromLLM)) {
                    const arrayKey = Object.keys(updatedFieldsFromLLM).find(key => Array.isArray(updatedFieldsFromLLM[key]));
                    if (arrayKey) {
                        console.log(`Found array in key '${arrayKey}', unwrapping it.`);
                        updatedFieldsFromLLM = updatedFieldsFromLLM[arrayKey];
                    }
                }

                if (!Array.isArray(updatedFieldsFromLLM)) {
                    console.error("LLM did not return a valid array after attempting to unwrap.", updatedFieldsFromLLM);
                    return fields; // return original fields to avoid crash
                }

                // Create a map from the LLM response using the _id
                const updatedFieldsMap = new Map();
                updatedFieldsFromLLM.forEach(field => {
                    if (field._id !== undefined) {
                        updatedFieldsMap.set(field._id, field);
                    }
                });

                // Merge the updates back into the original fields array
                const finalFields = fields.map((originalField, index) => {
                    const updatedField = updatedFieldsMap.get(index);
                    if (updatedField) {
                        // The LLM returns an object without htmlChunk and _id is temporary
                        const { _id, ...restOfUpdatedField } = updatedField;
                        return {
                            ...originalField, // Keeps htmlChunk
                            ...restOfUpdatedField // Overwrites everything else if changed by LLM
                        };
                    }
                    return originalField;
                });

                return finalFields;

            } catch (e) {
                console.error("添加填充值时出错:", e);
                return fields; // return original fields on error
            }
        }

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
                    
                    // Find the best element that matches the question and is not yet filled.
                    let minDistance = Infinity;
                    let bestElement = null;
                    let bestLabel = '';
                    const normalize = str => (str || '').replace(/\s+/g, '').toLowerCase();
                    const normQuestion = normalize(question);

                    for (const el of potentialElements) {
                        const uniqueElSelector = this.getUniqueSelector(el);
                        if (this.successfully_filled_fields.has(uniqueElSelector)) {
                            continue; // Skip already filled elements
                        }

                        // 向上查找最近的父节点，其 textContent 包含 question 文本
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
                    // 选取距离最近的那个
                    if (bestElement) {
                        console.log(`[歧义处理] 选择距离问题文本最近的元素 (父节点内容: "${bestLabel}")。`);
                        elementToProcess = bestElement;
                    }
                } else if (potentialElements.length === 1) {
                    elementToProcess = potentialElements[0];
                }

                // If we found an element, get its unique selector for processing and tracking
                if (elementToProcess) {
                    const uniqueSelector = this.getUniqueSelector(elementToProcess);
                    // Check if this specific element has already been filled. This can happen if two
                    // fields from the LLM point to the same element.
                    if (this.successfully_filled_fields.has(uniqueSelector)) {
                         console.warn(`[歧义处理] 目标元素 ${uniqueSelector} (问题: "${question}") 已经被填充过，将跳过。`);
                         return;
                    }
                    selector = uniqueSelector; // This is the key change: we now use the unique selector.
                }
                
            } catch (e) {
                console.warn(`初始选择器 "${selector}" 无效: ${e.message}`);
                // Let the retry loop handle it.
            }
            // --- End of Ambiguity Resolution ---

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                let element;
                try {
                    element = document.querySelector(selector);
                } catch (e) {
                    lastError = e;
                    console.warn(`Attempt ${attempt}/${MAX_RETRIES}: Invalid selector: \"${selector}\". Error: ${e.message}`);
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
                    // Use the unique selector for tracking
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
            
            this.statusUI.update(`🤔 字段 "${question}" 填充失败，尝试纠错...`);
            const fieldForCorrection = { ...field, selector: selector };
            const correctedField = await this.correctFieldWithLLM(fieldForCorrection, lastError, profile);
            
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
                        // 优化：如果元素已经是选中状态，则直接视为成功。
                        if (element.checked || element.getAttribute('aria-checked') === 'true') {
                            console.log(`元素 "${element.outerHTML}" 已经是选中状态，跳过点击。`);
                            return;
                        }
                        element.click();
                        // 使用新的、更鲁棒的验证方法
                        await this.verifyClickSuccess(element);
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

        async verifyClickSuccess(element) {
            return new Promise((resolve, reject) => {
                const timeout = 500; // 等待状态生效的最长时间 (ms)
                const interval = 50;  // 检查间隔 (ms)
                let elapsedTime = 0;
    
                const check = () => {
                    // 1. 检查标准 'checked' 属性
                    if (element.checked) {
                        resolve();
                        return;
                    }
    
                    // 2. 检查 ARIA 属性
                    if (element.getAttribute('aria-checked') === 'true') {
                        resolve();
                        return;
                    }
    
                    // 3. 检查元素自身或其父元素的常见 class
                    const commonCheckedClasses = ['checked', 'selected', 'active', 'is-checked', 't-is-checked'];
                    const parent = element.parentElement;
                    for (const cls of commonCheckedClasses) {
                        if (element.classList.contains(cls) || (parent && parent.classList.contains(cls))) {
                            resolve();
                            return;
                        }
                    }
    
                    // 如果未满足条件，则在超时前继续检查
                    elapsedTime += interval;
                    if (elapsedTime >= timeout) {
                        reject(new Error(`元素 "${element.outerHTML}" 在点击后未能确认其选中状态。`));
                    } else {
                        setTimeout(check, interval);
                    }
                };
    
                check(); // 开始检查
            });
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

            console.log(originalField);
            // 尝试用问题文本在整个body中定位上下文
            console.log('[纠错模式] 使用关联的HTML块或问题文本定位上下文。');
            if (originalField.question) {
                const bodyHtml = document.body.outerHTML;
                const idx = bodyHtml.indexOf(originalField.question);
                console.log(`问题文本 "${originalField.question}" 在body中索引位置: ${idx}`);
                if (idx !== -1) {
                    const start = Math.max(0, idx - 1000);
                    const end = Math.min(bodyHtml.length, idx + originalField.question.length + 1000);
                    htmlContext = bodyHtml.substring(start, end);
                    console.log('[纠错模式] 通过问题文本在body中定位到上下文，并截取问题文本上下1000字符。');
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

            try {
                const correctionPrompt = `
                    你是一个Web自动化专家。一个自动化脚本在网页上填充字段时可能失败了。
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

                const correction = await askLLM(correctionPrompt, 'gpt-4.1');

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

    // Listen for messages from the background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'start-filling') {
            // Ensure we have a fresh agent instance for each run
            if (window.formFillerAgent && !window.formFillerAgent.isStopped) {
                console.log("填充任务已在进行中。");
                return;
            }
            window.formFillerAgent = new FormFillerAgent();
            window.formFillerAgent.start(request.payload);

        } else if (request.type === 'stop-filling') {
            if (window.formFillerAgent) {
                window.formFillerAgent.isStopped = true;
                console.log("中断信号已接收。将在当前步骤完成后停止。");
            }
        }
        return true; // Keep the message channel open for async response
    });

    // const agent = new FormFillerAgent(); // Agent is now created on demand
})();

