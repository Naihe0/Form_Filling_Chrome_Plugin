(async function () {
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
        // 组装profile
        return (Array.isArray(data) ? data : []).map(item => ({
            memory: item.memory,
            categories: item.categories,
            date: item.created_at ? item.created_at.split('T')[0] : '',
            day_of_week: item.structured_attributes?.day_of_week || ''
        }));
    }
    // ===== end mem0_profile.js 逻辑 =====

    // --- Helper function to communicate with background script ---
    async function askLLM(prompt, model = 'gpt-4.1') {
        const { apiKey } = await chrome.storage.local.get('apiKey');
        if (!apiKey) {
            alert("请先在插件弹窗中设置您的 OpenAI API Key。");
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
            this.timerInterval = null; // UNIFIED: To hold the interval ID for all timers
            this.hideTimeout = null;   // To hold the auto-hide timeout ID
            this.init();
        }

        init() {
            const existingOverlay = document.getElementById('form-filler-overlay');

            if (existingOverlay) {
                this.overlay = existingOverlay;
                this.statusTextElement = this.overlay.querySelector('span'); 
                if (!this.statusTextElement) {
                    console.error("StatusUI Error: Overlay exists, but status text element not found within it.");
                    this.statusTextElement = document.createElement('span');
                    this.overlay.appendChild(this.statusTextElement);
                }
                return;
            }

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
            this.stopTimer(); // Stop any running timer when a new static message is set.
            if (!this.overlay || this.overlay.style.opacity === '0') {
                this.init();
            }
            if (!this.statusTextElement) {
                console.error("StatusUI Error: statusTextElement is null in update(). This should not happen.");
                this.init(); 
                if (!this.statusTextElement) return; // If still null, abort.
            }
            this.statusTextElement.textContent = message;
        }

        startTimer(baseMessage) {
            this.stopTimer(); // Ensure no other timer is running
            const startTime = Date.now();
            
            const updateWithTime = () => {
                const elapsedTime = Math.round((Date.now() - startTime) / 1000);
                const timedMessage = `${baseMessage} (${elapsedTime}s)`;
                // Directly update text content to avoid calling `update()` and causing recursion
                if (!this.statusTextElement) {
                    this.init();
                    if (!this.statusTextElement) return; // Guard against init failure
                }
                this.statusTextElement.textContent = timedMessage;
            };
            
            updateWithTime(); // Initial update
            this.timerInterval = setInterval(updateWithTime, 1000);
        }

        stopTimer() {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            if (this.hideTimeout) {
                clearTimeout(this.hideTimeout);
                this.hideTimeout = null;
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
                let { profile: userProfile, model, mem0Enable, mem0UserId, mem0ApiKey, mem0OrgId, mem0ProjectId, correctionEnabled } = payload;

                this.model = model || 'gpt-4.1';

                // 检查mem0开关，若开启则优先拉取mem0 profile
                if (mem0Enable) {
                    this.statusUI.update("⏳ 正在从mem0平台拉取用户画像...");
                    try {
                        const mem0ProfileArr = await fetchMem0Profile({
                            user_id: mem0UserId,
                            apiKey: mem0ApiKey,
                            orgId: mem0OrgId,
                            projectId: mem0ProjectId
                        });
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
                        selectedModel: this.model, // Pass the selected model
                        correctionEnabled: correctionEnabled // 传递纠错开关状态
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
                while (page_has_changed) {
                    if (this.isStopped) {
                        break;
                    }

                    // Start timer and show initial message
                    this.statusUI.startTimer("🔍 正在提取页面字段...");
                    const all_fields_on_page = await FieldExtractor.extractFields();
                    this.statusUI.stopTimer(); // Stop timer after extraction is complete

                    if (this.isStopped) break;

                    if (!all_fields_on_page || all_fields_on_page.length === 0) {
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
                            this.statusUI.update("👍 所有字段均已填充。");
                        }
                    }

                    if (this.isStopped) break;

                    // page_has_changed = await this.navigateToNextPage();
                    page_has_changed = false; // 在填充完一页后终止
                }

                if (this.isStopped) {
                    // alert("表单填充已由用户手动中断。"); // Alert is handled by popup
                    this.statusUI.update("🛑 填充已中断。");
                } else {
                    alert("表单填充完成！\n\n请仔细检查所有表单内容，LLM自动填写结果可能存在误差或不符合实际需求。请务必确认无误后再提交表单。");
                    this.statusUI.update("✅ 表单填充完成！");
                }
            } catch (e) {
                console.error("表单填充过程中发生未捕获的错误:", e);
                alert("表单填充过程中发生错误，请查看控制台日志。");
                this.statusUI.update("❌ 发生错误，请查看控制台。");
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

    // ========================================================================
    // == QUICK QUERY LOGIC                                                ==
    // ========================================================================
    class QuickQueryHandler {
        constructor(options) {
            this.userProfile = options.userProfile;
            this.model = options.model;
            this.askLLM = options.askLLM;
            this.statusUI = null;
            this.activeElement = null; // 追踪当前激活的元素

            // 绑定 this，确保在事件监听器中 this 指向 QuickQueryHandler 实例
            this.handleFocus = this.handleFocus.bind(this);
            this.handleBlur = this.handleBlur.bind(this);
            this.handleInput = this.handleInput.bind(this);
        }

        start() {
            // 使用事件捕获（capture=true）来更早地捕获 focus 和 blur 事件
            document.addEventListener('focus', this.handleFocus, true);
            document.addEventListener('blur', this.handleBlur, true);
            console.log("QuickQueryHandler started. Watching for focus events.");
        }

        stop() {
            document.removeEventListener('focus', this.handleFocus, true);
            document.removeEventListener('blur', this.handleBlur, true);
            // 如果在停止时仍有激活的元素，移除其 input 监听器
            if (this.activeElement) {
                this.activeElement.removeEventListener('input', this.handleInput);
            }
            console.log("QuickQueryHandler stopped.");
        }

        // 当任何元素获得焦点时调用
        handleFocus(event) {
            const target = event.target;
            // 检查目标元素是否是我们关心的输入类型
            const isTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
            const isContentEditable = target.isContentEditable;

            if (isTextInput || isContentEditable) {
                // 移除旧的监听器（如果有的话）
                if (this.activeElement) {
                    this.activeElement.removeEventListener('input', this.handleInput);
                }
                // 为新获得焦点的元素添加 'input' 监听器
                this.activeElement = target;
                this.activeElement.addEventListener('input', this.handleInput);
            }
        }

        // 当元素失去焦点时调用
        handleBlur(event) {
            // 如果失去焦点的元素是我们正在追踪的元素，则移除监听器
            if (this.activeElement && this.activeElement === event.target) {
                this.activeElement.removeEventListener('input', this.handleInput);
                this.activeElement = null;
            }
        }

        // 当被监听的输入框内容变化时调用
        handleInput(event) {
            const element = event.target;
            const value = element.isContentEditable ? element.textContent : element.value;

            // 检查内容是否以触发器结尾
            if (value && (value.endsWith('```') || value.endsWith('···'))) {
                // 异步触发，避免阻塞当前的 input 事件流
                setTimeout(() => this.triggerQuickQuery(element, value), 0);
            }
        }

        async triggerQuickQuery(element, currentValue) {
            // 移除触发字符
            const queryValue = currentValue.slice(0, -3);

            this.statusUI = new StatusUI();
            this.statusUI.startTimer("🚀 正在为您生成内容...");

            try {
                const prompt = this.constructPrompt(queryValue);
                const response = await this.askLLM(prompt, this.model);

                let resultText = '';
                if (typeof response === 'string') {
                    resultText = response;
                } else if (typeof response.answer === 'string') {
                    resultText = response.answer;
                } else {
                    throw new Error("LLM 返回了未知格式的数据。");
                }

                // 使用健壮的方法设置最终的文本内容
                this.setElementValue(element, queryValue + resultText);
                this.statusUI.update("✅ 内容已生成并填充！");

            } catch (error) {
                console.error("快捷问询失败:", error);
                this.statusUI.update(`❌ 快捷问询失败: ${error.message}`);
            } finally {
                if (this.statusUI) {
                    setTimeout(() => {
                        this.statusUI.remove();
                        this.statusUI = null;
                    }, 3000);
                }
            }
        }

        // (这个方法保持和你之前版本的一致)
        setElementValue(element, value) {
            if (element.isContentEditable) {
                element.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, value);
                return;
            }
            const elementPrototype = Object.getPrototypeOf(element);
            const valueSetter = Object.getOwnPropertyDescriptor(elementPrototype, 'value')?.set;
            if (valueSetter) {
                valueSetter.call(element, value);
            } else {
                element.value = value;
            }
            element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }

        constructPrompt(inputValue) {
            return `
            用户的个人信息（用户画像）如下:
            ---
            ${this.userProfile}
            ---

            用户当前正在一个表单字段中，并输入了以下内容:
            ---
            ${inputValue}
            ---

            请根据用户的个人信息和已有输入，生成一个合适内容。
            请直接返回最终的文本结果，不要包含任何额外的解释或标记。
            `;
        }
    }

    // --- SCRIPT INITIALIZATION ---
    async function initializeQuickQueryOnLoad() {
        try {
            const local = await new Promise(res => chrome.storage.local.get(['quick_query_enabled', 'userProfile', 'selectedModel', 'apiKey', 'userProfile_ts'], res));
            const sync = await new Promise(res => chrome.storage.sync.get(['quick_query_enabled', 'userProfile', 'selectedModel', 'apiKey', 'userProfile_ts'], res));

            // Prioritize sync over local for the enabled flag
            const isEnabled = typeof sync.quick_query_enabled !== 'undefined' ? sync.quick_query_enabled : local.quick_query_enabled;
            if (isEnabled) {

                let userProfile = (sync.userProfile_ts || 0) > (local.userProfile_ts || 0) ? sync.userProfile : local.userProfile;
                let selectedModel = sync.selectedModel || local.selectedModel;
                let apiKey = sync.apiKey || local.apiKey;

                if (!userProfile || !apiKey) {
                    console.warn("快捷问询自动激活失败：未找到用户画像或API Key。请在插件弹窗中设置。");
                    return;
                }

                // Ensure no existing handler is running before starting a new one
                if (window.quickQueryHandler) {
                    window.quickQueryHandler.stop();
                }
                
                window.quickQueryHandler = new QuickQueryHandler({
                    userProfile: userProfile,
                    model: selectedModel || 'gpt-4.1',
                    askLLM: askLLM
                    // statusUI: new StatusUI() //不再预先创建
                });
                window.quickQueryHandler.start();
            }
        } catch (error) {
            console.error("初始化快捷问询功能时出错:", error);
        }
    }

    // Listen for messages from the background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'start-filling') {
            // Ensure we have a fresh agent instance for each run
            if (window.formFillerAgent && !window.formFillerAgent.isStopped) {
                return;
            }
            window.formFillerAgent = new FormFillerAgent();
            window.formFillerAgent.start(request.payload);

        } else if (request.type === 'stop-filling') {
            if (window.formFillerAgent) {
                window.formFillerAgent.isStopped = true;
            }
        } else if (request.type === 'toggle-quick-query') {
            const { enabled, profile, model } = request.payload;
            if (enabled) {
                if (window.quickQueryHandler) {
                    window.quickQueryHandler.stop();
                }
                window.quickQueryHandler = new QuickQueryHandler({
                    userProfile: profile,
                    model: model,
                    askLLM: askLLM
                    // statusUI: new StatusUI() //不再预先创建
                });
                window.quickQueryHandler.start();
            } else {
                if (window.quickQueryHandler) {
                    window.quickQueryHandler.stop();
                    window.quickQueryHandler = null;
                }
            }
        }
        return true; // Keep the message channel open for async response
    });

    // Run initialization when the script loads
    initializeQuickQueryOnLoad();

    // const agent = new FormFillerAgent(); // Agent is now created on demand
})();

