(async function() {
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

    console.log("智能表单填充助手：内容脚本已加载。" );

    // --- Helper function to communicate with background script ---
    async function askLLM(prompt, model = 'gpt-4.1') {
        const { apiKey } = await chrome.storage.local.get('apiKey');
        if (!apiKey) {
            alert("请先在插件弹窗中设置您的 OpenAI API Key。" );
            throw new Error("API Key not found.");
        }

        const llmPromise = new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { type: 'llm-request', payload: { prompt, apiKey, model } },
                (response) => {
                    if (chrome.runtime.lastError) {
                        return reject(new Error(chrome.runtime.lastError.message));
                    }
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

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('LLM request timed out after 90 seconds.')), 90000) // 90-second timeout
        );

        return Promise.race([llmPromise, timeoutPromise]);
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

                // Initialize the field extractor with the correct model for this run
                if (typeof FieldExtractor !== 'undefined') {
                    FieldExtractor.init({
                        statusUI: this.statusUI,
                        askLLM: askLLM,
                        selectedModel: this.model,
                        isStopped: () => this.isStopped
                    });
                } else {
                    console.error("CRITICAL: FieldExtractor is not loaded. fieldExtractor.js must be injected.");
                    this.statusUI.update("❌ 关键错误：模块加载失败！");
                    return;
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
                    const all_fields_on_page = await FieldExtractor.extractFields();
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
                            const fields_with_values = await FieldExtractor.addValuesToFields(fields_to_fill, userProfile);
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
                alert("表单填充过程中发生错误，请查看控制台日志。" );
                this.statusUI.update("❌ 发生错误，请查看控制台。" );
            } finally {
                // 确保无论成功、失败还是中断，都重置UI状态
                chrome.storage.local.set({ isFilling: false });
                chrome.storage.sync.set({ isFilling: false });
                // 延迟移除状态栏，以便用户看到最终状态
                setTimeout(() => this.statusUI.remove(), 3000);
            }
        }

        // All field extraction and value-adding logic has been moved to fieldExtractor.js
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

