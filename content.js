(async function() {
    // ===== mem0_profile.js 逻辑内嵌 =====
    /**
     * 拉取mem0平台的用户画像
     * @param {Object} options
     * @param {string} options.user_id
     * @param {string} options.apiKey
     * @param {string} options.orgId
     * @param {string} options.projectId
     * @param {string} [options.dateFrom] - yyyy-mm-dd
     * @param {string} [options.dateTo] - yyyy-mm-dd
     * @returns {Promise<Array>} profile数组
     */
    async function fetchMem0Profile({ user_id, apiKey, orgId, projectId }) {
        const url = 'https://api.mem0.ai/v2/memories/';
        const body = {
            filters: {
                "AND": [
                    { "user_id": user_id },
                    { "run_id": "*" }
                ]
            },
            org_id: orgId,
            project_id: projectId
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('mem0 profile 拉取失败');
        const data = await res.json();
        console.log('[mem0 debug] mem0 profile 拉取结果:', data);
        // 组装profile
        return (Array.isArray(data) ? data : []).map(item => ({
            memory: item.memory,
            categories: item.categories,
            date: item.created_at ? item.created_at.split('T')[0] : '',
            day_of_week: item.structured_attributes?.day_of_week || ''
        }));
    }
    // ===== end mem0_profile.js 逻辑 =====

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
            this.timerInterval = null; // To hold the interval ID
            this.startTime = null; // To hold the start time
            this.baseMessage = ''; // To hold the base message for the timer
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

        updateBaseMessage(newBaseMessage) {
            this.baseMessage = newBaseMessage;
        }

        startTimer(baseMessage) {
            this.stopTimer(); // Ensure no other timer is running
            this.startTime = Date.now();
            this.baseMessage = baseMessage;
            const updateWithTime = () => {
                const elapsedTime = Math.round((Date.now() - this.startTime) / 1000);
                this.update(`${this.baseMessage} (${elapsedTime}s)`);
            };
            updateWithTime(); // Initial update
            this.timerInterval = setInterval(updateWithTime, 1000); // Update every second
        }

        stopTimer() {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
                this.startTime = null;
                this.baseMessage = '';
            }
        }

        remove() {
            this.stopTimer(); // Stop timer when removing the UI
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
            this.model = 'gpt-4.1'; // Default model
            // FieldProcessor will be initialized in the start() method
            // once the user-selected model is known.
        }

        async start(payload) {
            this.statusUI.update("🚀 开始填充表单...");
            try {
                let { profile: userProfile, model, mem0Enable, mem0UserId, mem0ApiKey, mem0OrgId, mem0ProjectId } = payload;
                this.model = model || 'gpt-4.1';

                console.log("用户信息:", userProfile);
                // 检查mem0开关，若开启则优先拉取mem0 profile
                if (mem0Enable) {
                    this.statusUI.update("⏳ 正在从mem0平台拉取用户画像...");
                    try {
                        console.log('[mem0 debug] 拉取参数:', {
                            user_id: mem0UserId,
                            apiKey: mem0ApiKey,
                            orgId: mem0OrgId,
                            projectId: mem0ProjectId,
                        });
                        const mem0ProfileArr = await fetchMem0Profile({
                            user_id: mem0UserId,
                            apiKey: mem0ApiKey,
                            orgId: mem0OrgId,
                            projectId: mem0ProjectId
                        });
                        console.log('[mem0 debug] mem0ProfileArr:', mem0ProfileArr);
                        // 组装成字符串格式
                        userProfile = mem0ProfileArr.map(item => {
                            return `memory: ${item.memory}\ncategories: ${item.categories?.join(',') || ''}\ndate: ${item.date}\nday_of_week: ${item.day_of_week}`;
                        }).join('\n---\n');
                        this.statusUI.update("mem0画像拉取成功，正在填充...");
                    } catch (e) {
                        this.statusUI.update("❌ mem0画像拉取失败，使用本地画像");
                        console.error('[mem0 debug] mem0画像拉取失败', e);
                    }
                }



                // Initialize the field processor with the correct model for this run
                if (typeof FieldProcessor !== 'undefined') {
                    FieldProcessor.init({
                        statusUI: this.statusUI,
                        successfully_filled_fields: this.successfully_filled_fields,
                        askLLM: askLLM, // Pass the global askLLM function
                        selectedModel: this.model // Pass the selected model
                    });
                } else {
                    console.error("CRITICAL: FieldProcessor is not loaded. fieldProcessor.js must be injected before content.js");
                    this.statusUI.update("❌ 关键错误：模块加载失败！");
                    // Stop execution if the critical module is missing
                    return;
                }

                // The API key is handled by the background script, no need to check for it here.
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
                    
                    // Start timer and show initial message
                    this.statusUI.startTimer("🔍 正在提取页面字段...");
                    const all_fields_on_page = await this.extractFields();
                    this.statusUI.stopTimer(); // Stop timer after extraction is complete

                    if (this.isStopped) break;

                    if (!all_fields_on_page || all_fields_on_page.length === 0) {
                        console.log("当前页面未找到可填充字段。");
                        this.statusUI.update("🤔 未找到可填充字段。");
                    } else {
                        const fields_to_fill = all_fields_on_page.filter(f => 
                            !this.successfully_filled_fields.has(f.selector)
                        );

                        if (fields_to_fill.length > 0) {
                            // Start timer for the value analysis phase
                            this.statusUI.startTimer(`🧠 正在请求LLM为 ${fields_to_fill.length} 个字段分析填充值...`);
                            const fields_with_values = await this.addValuesToFields(fields_to_fill, userProfile);
                            this.statusUI.stopTimer(); // Stop timer after analysis

                            if (this.isStopped) break;

                            let filledCount = 0;
                            for (const field of fields_with_values) {
                                if (this.isStopped) break;
                                
                                // Check if the LLM provided a value for this field
                                if (field.value !== undefined && field.value !== null) {
                                    filledCount++;
                                    this.statusUI.update(`✍️ 正在填充 (${filledCount}/${fields_to_fill.length}): ${field.question}`);
                                    // Delegate to the external processor
                                    await FieldProcessor.processSingleField(field, field.value, userProfile);
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
                // Update status base message with chunk progress
                this.statusUI.updateBaseMessage(`🔍 正在提取页面字段... (${index + 1}/${chunks.length})`);

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
            const prompt = 
            `
            你是一个HTML解析专家。严格分析以下网页问卷的HTML片段，
            并仅返回此片段中存在的所有问卷问题，选项等信息。输出一个纯JSON数组，
            其中每个对象代表一个问题。\n\n
            分块处理: 正在处理多个块中的第 ${chunkIndex} 块。\n\n
            每个字段对象必须包含:\n
            - 'question': 问题文本。\n
            - 'action': "click" 或 "fill"。\n
            - 'selector': 用来回当前问题，能够用JavaScript代码发起事件进行点击或者填充的选择器。如果问题是选择题，返回包含所有选项对应选择器的数组。\n
            - 'options': 一个包含所有可用选项文本的数组。\n\n
            
            指南:\n
            1.  **严格性**: 只分析提供的HTML。不要猜测或包含HTML之外的字段。确保输出是纯粹的、格式正确的JSON数组，不包含任何解释性文本。\n\n
            HTML片段如下:\n
            \`\`\`
            html\n${html}\n
            \`\`\`\n
            `;

            try {
                // console.log(`[LLM模式] Chunk #${chunkIndex} Prompt:\n`, prompt);
                console.log(`[LLM模式] Chunk #${chunkIndex} HTML to be processed (first 500 chars):\n`, html.substring(0, 500) + '...');
                let rawResponse = await askLLM(prompt, this.model); // Use the correct model
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
            let path = [];
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
            const prompt = `
            你是一个高度智能的AI表单填充助手。你的任务是根据用户资料，为给定的JSON字段数组中的每个对象添加一个 'value' 键。

            --- 用户资料 ---
            ${profile}

            --- 表单字段 (JSON数组) ---
            ${JSON.stringify(fieldsForPrompt, null, 2)}

            --- 填充规则 ---
            1.  **分析**: 仔细分析每个字段对象的 'question', 'action', 和 'options'。
            2.  **填充 'value'**: 根据用户资料和问题，确定最匹配的填充值。
                *   对于 **"action": "fill"**，'value' 应该是一个 **字符串**。
                *   对于 **"action": "click"** 的单选题，'value' 应该是一个 **字符串**，且必须是 'options' 数组中的一个值。
                *   对于 **"action": "click"** 的多选题，'value' 应该是一个 **字符串数组**，其中每个值都必须是 'options' 数组中的一个值。
                *   如果根据用户资料找不到任何匹配的答案，请 **不要** 添加 'value' 键，并原样保留该对象。
            3.  **保留ID**: 你 **必须** 在返回的每个JSON对象中保留原始的 '_id' 字段。
            4.  **输出**: 你的输出必须是，也只能是一个JSON数组，其中包含所有被处理过的字段对象。不要添加任何解释性文字或将它包装在另一个JSON对象中。

            --- 输出 (修改后的JSON数组) ---
            `;
            
            try {
                console.log("[LLM模式] 添加填充值的提示:", prompt);
                let updatedFieldsFromLLM = await askLLM(prompt, this.model); // Use the correct model
                console.log("LLM 返回的带填充值的字段:", updatedFieldsFromLLM);
                
                // Handle cases where LLM returns a single object instead of an array
                if (typeof updatedFieldsFromLLM === 'object' && updatedFieldsFromLLM !== null && !Array.isArray(updatedFieldsFromLLM)) {
                    const arrayKey = Object.keys(updatedFieldsFromLLM).find(key => Array.isArray(updatedFieldsFromLLM[key]));
                    if (arrayKey) {
                        console.log(`Found array in key '${arrayKey}', unwrapping it.`);
                        updatedFieldsFromLLM = updatedFieldsFromLLM[arrayKey];
                    } else {
                        // If the response is a single object, wrap it in an array to handle the case where only one field is returned.
                        console.log("LLM returned a single object, wrapping it in an array.");
                        updatedFieldsFromLLM = [updatedFieldsFromLLM];
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

        // All field processing logic has been moved to fieldProcessor.js
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

