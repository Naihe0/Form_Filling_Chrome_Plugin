// mem0-upload-toggle 独立持久化
const mem0UploadToggle = document.getElementById('mem0-upload-toggle');
const mem0EnableToggle = document.getElementById('mem0-enable-toggle');
const quickQueryToggle = document.getElementById('quick-query-toggle');
const correctionToggle = document.getElementById('reasoning-correction-toggle');
const MEM0_UPLOAD_KEY = 'mem0_upload_enabled';
const MEM0_ENABLE_KEY = 'mem0_enable_enabled';
const QUICK_QUERY_KEY = 'quick_query_enabled';
const CORRECTION_KEY = 'correction_enabled';
const CORRECTION_TS_KEY = 'correction_enabled_ts'; // Timestamp key

// 监听 mem0-upload-toggle
if (mem0UploadToggle) {
    mem0UploadToggle.addEventListener('change', e => {
        const checked = mem0UploadToggle.checked;
        chrome.storage.local.set({ [MEM0_UPLOAD_KEY]: checked });
        chrome.storage.sync.set({ [MEM0_UPLOAD_KEY]: checked });
    });
    // 初始化
    chrome.storage.local.get([MEM0_UPLOAD_KEY], localResult => {
        chrome.storage.sync.get([MEM0_UPLOAD_KEY], syncResult => {
            let val = false;
            if (typeof syncResult[MEM0_UPLOAD_KEY] !== 'undefined') val = syncResult[MEM0_UPLOAD_KEY];
            else if (typeof localResult[MEM0_UPLOAD_KEY] !== 'undefined') val = localResult[MEM0_UPLOAD_KEY];
            mem0UploadToggle.checked = !!val;
        });
    });
}
// 监听 mem0-enable-toggle
if (mem0EnableToggle) {
    mem0EnableToggle.addEventListener('change', e => {
        const checked = mem0EnableToggle.checked;
        chrome.storage.local.set({ [MEM0_ENABLE_KEY]: checked });
        chrome.storage.sync.set({ [MEM0_ENABLE_KEY]: checked });
    });
    // 初始化
    chrome.storage.local.get([MEM0_ENABLE_KEY], localResult => {
        chrome.storage.sync.get([MEM0_ENABLE_KEY], syncResult => {
            let val = false;
            if (typeof syncResult[MEM0_ENABLE_KEY] !== 'undefined') val = syncResult[MEM0_ENABLE_KEY];
            else if (typeof localResult[MEM0_ENABLE_KEY] !== 'undefined') val = localResult[MEM0_ENABLE_KEY];
            mem0EnableToggle.checked = !!val;
        });
    });
}
// 监听 quick-query-toggle
if (quickQueryToggle) {
    quickQueryToggle.addEventListener('change', async e => {
        const checked = quickQueryToggle.checked;
        chrome.storage.local.set({ [QUICK_QUERY_KEY]: checked });
        chrome.storage.sync.set({ [QUICK_QUERY_KEY]: checked });

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return;

            // 注入必要的脚本
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['fieldExtractor.js', 'fieldProcessor.js', 'content.js']
            });

            if (checked) {
                const local = await new Promise(res => chrome.storage.local.get(['userProfile', 'selectedModel', 'userProfile_ts', 'apiKey'], res));
                const sync = await new Promise(res => chrome.storage.sync.get(['userProfile', 'selectedModel', 'userProfile_ts', 'apiKey'], res));

                let userProfile = (sync.userProfile_ts || 0) > (local.userProfile_ts || 0) ? sync.userProfile : local.userProfile;
                let selectedModel = sync.selectedModel || local.selectedModel;
                let apiKey = sync.apiKey || local.apiKey;

                if (!userProfile || !apiKey) {
                    showStatus('使用快捷问询前，请先设置用户画像和API Key。', true);
                    quickQueryToggle.checked = false;
                    chrome.storage.local.set({ [QUICK_QUERY_KEY]: false });
                    chrome.storage.sync.set({ [QUICK_QUERY_KEY]: false });
                    return;
                }

                chrome.tabs.sendMessage(tab.id, {
                    type: 'toggle-quick-query',
                    payload: {
                        enabled: true,
                        profile: userProfile,
                        model: selectedModel || 'gpt-4.1'
                    }
                });
            } else {
                chrome.tabs.sendMessage(tab.id, {
                    type: 'toggle-quick-query',
                    payload: { enabled: false }
                });
            }
        } catch (error) {
            console.error("快捷问询切换失败:", error);
            showStatus(`快捷问询切换失败: ${error.message}`, true);
        }
    });
}

// 监听 correction-toggle
if (correctionToggle) {
    correctionToggle.addEventListener('change', e => {
        const checked = correctionToggle.checked;
        const ts = Date.now();
        chrome.storage.local.set({ [CORRECTION_KEY]: checked, [CORRECTION_TS_KEY]: ts });
        chrome.storage.sync.set({ [CORRECTION_KEY]: checked, [CORRECTION_TS_KEY]: ts });
    });
    // Duplicating the initialization from loadSettings here to avoid race conditions on popup open
    chrome.storage.local.get([CORRECTION_KEY, CORRECTION_TS_KEY], localResult => {
        chrome.storage.sync.get([CORRECTION_KEY, CORRECTION_TS_KEY], syncResult => {
            const localTs = localResult[CORRECTION_TS_KEY] || 0;
            const syncTs = syncResult[CORRECTION_TS_KEY] || 0;
            let val = false;
            if (syncTs > localTs) {
                val = syncResult[CORRECTION_KEY];
            } else {
                val = localResult[CORRECTION_KEY];
            }
            correctionToggle.checked = !!val;
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // --- Element References ---
    // Views
    const addView = document.getElementById('add-view');
    const fillView = document.getElementById('fill-view');
    const fillingView = document.getElementById('filling-view');
    const topButtonContainer = document.getElementById('top-button-container');

    // ADD View elements
    const profileDisplay = document.getElementById('profileDisplay');
    const editProfileButton = document.getElementById('editProfileButton');
    // 编辑模式状态
    let isEditingProfile = false;
    // 编辑按钮逻辑
    if (editProfileButton) {
        editProfileButton.addEventListener('click', () => {
            if (!isEditingProfile) {
                // 进入编辑模式
                profileDisplay.readOnly = false;
                profileDisplay.focus();
                editProfileButton.textContent = 'Save';
                isEditingProfile = true;
            } else {
                // 保存编辑内容
                profileDisplay.readOnly = true;
                editProfileButton.textContent = 'Edit';
                isEditingProfile = false;
                // 保存到本地和sync
                const newValue = profileDisplay.value;
                try {
                    let arr = JSON.parse(newValue);
                    if (!Array.isArray(arr)) arr = [newValue];
                    chrome.storage.local.set({ userProfile: JSON.stringify(arr), userProfile_ts: Date.now() });
                    chrome.storage.sync.set({ userProfile: JSON.stringify(arr), userProfile_ts: Date.now() });
                } catch {
                    let arr = newValue.split(/\n---\n/).map(s => s.trim()).filter(Boolean);
                    chrome.storage.local.set({ userProfile: JSON.stringify(arr), userProfile_ts: Date.now() });
                    chrome.storage.sync.set({ userProfile: JSON.stringify(arr), userProfile_ts: Date.now() });
                }
                showStatus('用户画像已更新！');
            }
        });
        // 实时同步内容到本地和sync
        profileDisplay.addEventListener('input', () => {
            if (isEditingProfile) {
                const newValue = profileDisplay.value;
                try {
                    let arr = JSON.parse(newValue);
                    if (!Array.isArray(arr)) arr = [newValue];
                    chrome.storage.local.set({ userProfile: JSON.stringify(arr), userProfile_ts: Date.now() });
                    chrome.storage.sync.set({ userProfile: JSON.stringify(arr), userProfile_ts: Date.now() });
                } catch {
                    let arr = newValue.split(/\n---\n/).map(s => s.trim()).filter(Boolean);
                    chrome.storage.local.set({ userProfile: JSON.stringify(arr), userProfile_ts: Date.now() });
                    chrome.storage.sync.set({ userProfile: JSON.stringify(arr), userProfile_ts: Date.now() });
                }
            }
        });
    }
    const userProfileInput = document.getElementById('userProfileInput');
    const saveProfileButton = document.getElementById('saveProfileButton');

    // FILL View elements
    const apiKeyInput = document.getElementById('apiKey');
    const modelSelect = document.getElementById('model-select');
    const startFillingButton = document.getElementById('startFillingButton');

    // Top buttons
    const addButton = document.getElementById('addButton');
    const fillButton = document.getElementById('fillButton');

    // Other elements
    const stopFillingButton = document.getElementById('stopFillingButton');
    const statusDiv = document.getElementById('status');

    // --- State Management ---
    let isFilling = false;
    let currentView = 'fill'; // 'add' or 'fill'

    // --- Functions ---

    /**
     * 统一的 mem0 参数弹窗函数
     * @param {function} onSave - 保存成功后的回调函数
     */
    function openMem0ParamModal(onSave) {
        const MEM0_KEYS = ['mem0ApiKey', 'mem0AgentId', 'mem0UserId', 'mem0AppId', 'mem0OrgId', 'mem0ProjectId'];
        chrome.storage.local.get(MEM0_KEYS.concat(['mem0ParamDraft']), localResult => {
            chrome.storage.sync.get(MEM0_KEYS.concat(['mem0ParamDraft']), syncResult => {
                let mem0ApiKey = syncResult.mem0ApiKey || localResult.mem0ApiKey || '';
                let mem0AgentId = syncResult.mem0AgentId || localResult.mem0AgentId || '';
                let mem0UserId = syncResult.mem0UserId || localResult.mem0UserId || '';
                let mem0AppId = syncResult.mem0AppId || localResult.mem0AppId || '';
                let mem0OrgId = syncResult.mem0OrgId || localResult.mem0OrgId || '';
                let mem0ProjectId = syncResult.mem0ProjectId || localResult.mem0ProjectId || '';
                let draft = syncResult.mem0ParamDraft || localResult.mem0ParamDraft || {};
                try { draft = typeof draft === 'string' ? JSON.parse(draft) : draft; } catch { draft = {}; }
                mem0ApiKey = draft.mem0ApiKey || mem0ApiKey;
                mem0AgentId = draft.mem0AgentId || mem0AgentId;
                mem0UserId = draft.mem0UserId || mem0UserId;
                mem0AppId = draft.mem0AppId || mem0AppId;
                mem0OrgId = draft.mem0OrgId || mem0OrgId;
                mem0ProjectId = draft.mem0ProjectId || mem0ProjectId;

                // 如果已存在弹窗，则不再创建
                if (document.getElementById('mem0-param-modal')) return;

                const formHtml = `
                    <div id="mem0-param-modal" style="position:fixed;z-index:99999;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
                      <div style="background:#fff;padding:24px 32px;border-radius:10px;box-shadow:0 2px 16px #0002;min-width:320px;max-width:90vw;">
                        <h3 style="margin-bottom:12px;">填写 mem0 参数</h3>
                        <div style="display:flex;flex-direction:column;gap:8px;">
                          <input id="mem0ApiKeyInput" placeholder="API Key" value="${mem0ApiKey}" style="padding:6px;" />
                          <input id="mem0AgentIdInput" placeholder="Agent ID" value="${mem0AgentId || 'form_filler_agent'}" style="padding:6px;" />
                          <input id="mem0UserIdInput" placeholder="User ID" value="${mem0UserId || 'form_filler_test_user'}" style="padding:6px;" />
                          <input id="mem0AppIdInput" placeholder="App ID" value="${mem0AppId || 'form_filling_tool'}" style="padding:6px;" />
                          <input id="mem0OrgIdInput" placeholder="Org ID" value="${mem0OrgId}" style="padding:6px;" />
                          <input id="mem0ProjectIdInput" placeholder="Project ID" value="${mem0ProjectId}" style="padding:6px;" />
                        </div>
                        <div style="margin-top:16px;text-align:right;">
                          <button id="mem0ParamSaveBtn" style="padding:6px 18px;">保存</button>
                        </div>
                      </div>
                    </div>`;
                const modal = document.createElement('div');
                modal.innerHTML = formHtml;
                document.body.appendChild(modal);

                const inputIds = [
                    'mem0ApiKeyInput', 'mem0AgentIdInput', 'mem0UserIdInput', 'mem0AppIdInput', 'mem0OrgIdInput', 'mem0ProjectIdInput'
                ];
                inputIds.forEach(id => {
                    const input = document.getElementById(id);
                    input.addEventListener('input', () => {
                        const draftObj = {
                            mem0ApiKey: document.getElementById('mem0ApiKeyInput').value.trim(),
                            mem0AgentId: document.getElementById('mem0AgentIdInput').value.trim(),
                            mem0UserId: document.getElementById('mem0UserIdInput').value.trim(),
                            mem0AppId: document.getElementById('mem0AppIdInput').value.trim(),
                            mem0OrgId: document.getElementById('mem0OrgIdInput').value.trim(),
                            mem0ProjectId: document.getElementById('mem0ProjectIdInput').value.trim()
                        };
                        chrome.storage.local.set({ mem0ParamDraft: JSON.stringify(draftObj) });
                        chrome.storage.sync.set({ mem0ParamDraft: JSON.stringify(draftObj) });
                    });
                });

                document.getElementById('mem0ParamSaveBtn').onclick = () => {
                    const mem0ApiKey = document.getElementById('mem0ApiKeyInput').value.trim();
                    const mem0AgentId = document.getElementById('mem0AgentIdInput').value.trim();
                    const mem0UserId = document.getElementById('mem0UserIdInput').value.trim();
                    const mem0AppId = document.getElementById('mem0AppIdInput').value.trim();
                    const mem0OrgId = document.getElementById('mem0OrgIdInput').value.trim();
                    const mem0ProjectId = document.getElementById('mem0ProjectIdInput').value.trim();
                    if (!mem0ApiKey || !mem0AgentId || !mem0UserId || !mem0AppId || !mem0OrgId || !mem0ProjectId) {
                        alert('所有 mem0 参数都不能为空！');
                        return;
                    }
                    const saveObj = { mem0ApiKey, mem0AgentId, mem0UserId, mem0AppId, mem0OrgId, mem0ProjectId };
                    chrome.storage.local.set(saveObj);
                    chrome.storage.sync.set(saveObj, () => {
                        chrome.storage.local.remove('mem0ParamDraft');
                        chrome.storage.sync.remove('mem0ParamDraft');
                        document.body.removeChild(modal);
                        showStatus('mem0 参数已保存！');
                        if (typeof onSave === 'function') {
                            onSave(saveObj);
                        }
                    });
                };
            });
        });
    }

    /**
     * 异步获取 mem0 参数
     * @returns {Promise<object>}
     */
    function getMem0Parameters() {
        return new Promise((resolve, reject) => {
            const MEM0_KEYS = ['mem0ApiKey', 'mem0AgentId', 'mem0UserId', 'mem0AppId', 'mem0OrgId', 'mem0ProjectId'];
            chrome.storage.local.get(MEM0_KEYS, localResult => {
                chrome.storage.sync.get(MEM0_KEYS, syncResult => {
                    const mem0Params = {
                        mem0ApiKey: syncResult.mem0ApiKey || localResult.mem0ApiKey,
                        mem0AgentId: syncResult.mem0AgentId || localResult.mem0AgentId,
                        mem0UserId: syncResult.mem0UserId || localResult.mem0UserId,
                        mem0AppId: syncResult.mem0AppId || localResult.mem0AppId,
                        mem0OrgId: syncResult.mem0OrgId || localResult.mem0OrgId,
                        mem0ProjectId: syncResult.mem0ProjectId || localResult.mem0ProjectId
                    };
                    if (Object.values(mem0Params).some(p => !p)) {
                        reject(new Error('mem0 参数不完整'));
                    } else {
                        resolve(mem0Params);
                    }
                });
            });
        });
    }

    /**
     * Shows a status message for a short duration.
     * @param {string} message - The message to display.
     * @param {boolean} isError - If true, formats as an error.
     */
    function showStatus(message, isError = false) {
        // 在状态栏下方显示“修改mem0参数”按钮（仅mem0相关错误时）
        if (message && /mem0/.test(message)) {
            let editBtn = document.getElementById('edit-mem0-param-btn');
            if (!editBtn) {
                editBtn = document.createElement('button');
                editBtn.id = 'edit-mem0-param-btn';
                editBtn.textContent = '修改 mem0 参数';
                editBtn.style.marginTop = '8px';
                editBtn.style.background = '#f3f4f6';
                editBtn.style.border = '1px solid #d1d5db';
                editBtn.style.color = '#374151';
                editBtn.style.padding = '4px 12px';
                editBtn.style.borderRadius = '6px';
                editBtn.style.cursor = 'pointer';
                editBtn.onclick = openMem0ParamModal;
                statusDiv.parentNode.insertBefore(editBtn, statusDiv.nextSibling);
            }
        } else {
            const btn = document.getElementById('edit-mem0-param-btn');
            if (btn) btn.remove();
        }
        statusDiv.textContent = message;
        statusDiv.style.color = isError ? '#b91c1c' : '#4b5563';
        setTimeout(() => statusDiv.textContent = '', 3000);
    }

    /**
     * Updates the UI based on the current state (which view is active).
     */
    function updateUI() {
        // Hide all main views first
        addView.classList.add('hidden');
        fillView.classList.add('hidden');
        fillingView.classList.add('hidden');

        // Show/hide top buttons based on filling state
        topButtonContainer.style.display = isFilling ? 'none' : 'flex';

        if (isFilling) {
            fillingView.classList.remove('hidden');
        } else {
            if (currentView === 'add') {
                addView.classList.remove('hidden');
                addButton.classList.add('active');
                fillButton.classList.remove('active');
            } else { // 'fill' view
                fillView.classList.remove('hidden');
                fillButton.classList.add('active');
                addButton.classList.remove('active');
            }
        }
    }

    /**
     * Saves the user profile from the input field to storage.
     */
    function saveProfile() {
        const userProfile = userProfileInput.value.trim();
        if (!userProfile) {
            showStatus("用户画像内容不能为空！", true);
            return;
        }

        // 读取本地和sync，优先用最新
        chrome.storage.local.get(['userProfile', 'userProfile_ts'], (localResult) => {
            chrome.storage.sync.get(['userProfile', 'userProfile_ts'], (syncResult) => {
                let localTs = localResult.userProfile_ts || 0;
                let syncTs = syncResult.userProfile_ts || 0;
                let history = [];
                if (syncTs > localTs) {
                    try {
                        history = JSON.parse(syncResult.userProfile);
                        if (!Array.isArray(history)) history = [syncResult.userProfile];
                    } catch {
                        history = [syncResult.userProfile];
                    }
                } else if (localResult.userProfile) {
                    try {
                        history = JSON.parse(localResult.userProfile);
                        if (!Array.isArray(history)) history = [localResult.userProfile];
                    } catch {
                        history = [localResult.userProfile];
                    }
                }
                history.push(userProfile);
                const ts = Date.now();
                chrome.storage.local.set({ userProfile: JSON.stringify(history), userProfile_ts: ts });
                chrome.storage.sync.set({ userProfile: JSON.stringify(history), userProfile_ts: ts }, () => {
                    userProfileInput.value = '';
                    showStatus('用户画像已保存！');
                    profileDisplay.value = history.join('\n---\n');
                });
            });
        });

        // 判断是否需要上传 mem0
        // 统一用mem0UploadToggle的checked
        if (mem0UploadToggle && mem0UploadToggle.checked) {
            const uploadToMem0 = (params) => {
                const body = {
                    messages: [{ role: 'user', content: userProfile }],
                    agent_id: params.mem0AgentId,
                    user_id: params.mem0UserId,
                    app_id: params.mem0AppId,
                    infer: true,
                    org_id: params.mem0OrgId,
                    project_id: params.mem0ProjectId,
                    version: 'v2'
                };
                (async () => {
                    try {
                        const response = await fetch('https://api.mem0.ai/v1/memories/', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Token ${params.mem0ApiKey}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(body)
                        });
                        const data = await response.json();
                        if (response.ok && Array.isArray(data) && data[0]?.data?.memory) {
                            showStatus('mem0 上传成功！');
                        } else if (data.error) {
                            showStatus(`mem0 上传失败: ${data.details?.message || data.error}`, true);
                        } else {
                            showStatus('mem0 返回未知格式', true);
                        }
                    } catch (e) {
                        showStatus(`mem0 上传异常: ${e.message}`, true);
                    }
                })();
            };

            getMem0Parameters()
                .then(uploadToMem0)
                .catch(() => {
                    // 参数不完整，弹窗让用户填写，保存后直接上传
                    openMem0ParamModal(uploadToMem0);
                });
        }
    }

    /**
     * Saves the API Key to storage.
     * @returns {boolean} - True if key is valid, false otherwise.
     */
    function saveApiKey() {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            showStatus('Please enter your API key.', true);
            return false;
        }
        chrome.storage.local.set({ apiKey });
        chrome.storage.sync.set({ apiKey });
        return true;
    }

    /**
     * Saves the selected model to storage.
     */
    function saveModel() {
        const selectedModel = modelSelect.value;
        chrome.storage.local.set({ selectedModel });
        chrome.storage.sync.set({ selectedModel });
    }

    /**
     * Loads all settings from chrome.storage when the popup opens.
     */
    function loadSettings() {
        const ALL_KEYS = [
            'apiKey', 'userProfile', 'selectedModel', 'isFilling', 'userProfile_ts',
            MEM0_UPLOAD_KEY, MEM0_ENABLE_KEY, QUICK_QUERY_KEY, CORRECTION_KEY, CORRECTION_TS_KEY
        ];
        // 读取本地和sync，优先用最新
        chrome.storage.local.get(ALL_KEYS, (localResult) => {
            chrome.storage.sync.get(ALL_KEYS, (syncResult) => {

                // Helper to get the most recent value
                const getValue = (key) => {
                    // For userProfile, compare timestamps
                    if (key === 'userProfile') {
                        const localTs = localResult.userProfile_ts || 0;
                        const syncTs = syncResult.userProfile_ts || 0;
                        return syncTs > localTs ? syncResult.userProfile : localResult.userProfile;
                    }
                    // For other keys, sync wins
                    return syncResult[key] !== undefined ? syncResult[key] : localResult[key];
                };

                // apiKey, selectedModel, isFilling
                if (getValue('apiKey')) apiKeyInput.value = getValue('apiKey');
                if (getValue('selectedModel')) modelSelect.value = getValue('selectedModel');
                isFilling = !!getValue('isFilling');

                // 用户画像
                const userProfileRaw = getValue('userProfile');
                if (userProfileRaw) {
                    try {
                        let arr = JSON.parse(userProfileRaw);
                        if (!Array.isArray(arr)) arr = [userProfileRaw];
                        profileDisplay.value = arr.join('\n---\n');
                    } catch {
                        profileDisplay.value = userProfileRaw;
                    }
                }

                // 恢复所有开关的状态
                if (mem0UploadToggle) mem0UploadToggle.checked = !!getValue(MEM0_UPLOAD_KEY);
                if (mem0EnableToggle) mem0EnableToggle.checked = !!getValue(MEM0_ENABLE_KEY);
                if (quickQueryToggle) quickQueryToggle.checked = !!getValue(QUICK_QUERY_KEY);
                if (correctionToggle) {
                    // Use the more robust timestamp comparison for the correction toggle
                    const localTs = localResult[CORRECTION_TS_KEY] || 0;
                    const syncTs = syncResult[CORRECTION_TS_KEY] || 0;
                    const correctionValue = syncTs > localTs ? syncResult[CORRECTION_KEY] : localResult[CORRECTION_KEY];
                    correctionToggle.checked = !!correctionValue;
                }


                updateUI();
            });
        });
    }

    // --- Event Listeners ---

    // Switch to ADD view
    addButton.addEventListener('click', () => {
        if (isFilling) return;
        currentView = 'add';
        updateUI();
    });

    // Switch to FILL view
    fillButton.addEventListener('click', () => {
        if (isFilling) return;
        currentView = 'fill';
        updateUI();
    });

    // Save Profile button
    saveProfileButton.addEventListener('click', saveProfile);

    // Save model on change
    modelSelect.addEventListener('change', saveModel);

    // Start Filling button
    startFillingButton.addEventListener('click', async () => {
        // Save the API key and check if it's valid before starting
        if (!saveApiKey()) {
            return;
        }
        // Also save the model preference
        saveModel();

        isFilling = true;
        chrome.storage.local.set({ isFilling: true });
        chrome.storage.sync.set({ isFilling: true });
        updateUI();
        showStatus('正在开始填充...');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            // --- SCRIPT INJECTION ---
            // In Manifest V3, we must programmatically inject scripts.
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['fieldExtractor.js', 'fieldProcessor.js', 'content.js']
            });

            // 读取本地和sync，优先用最新
            const local = await new Promise(res => chrome.storage.local.get(['userProfile', 'selectedModel', 'userProfile_ts'], res));
            const sync = await new Promise(res => chrome.storage.sync.get(['userProfile', 'selectedModel', 'userProfile_ts'], res));
            let localTs = local.userProfile_ts || 0;
            let syncTs = sync.userProfile_ts || 0;
            let userProfile = '';
            if (syncTs > localTs) userProfile = sync.userProfile;
            else userProfile = local.userProfile;
            let selectedModel = sync.selectedModel || local.selectedModel;

            if (!userProfile) {
                showStatus('请先在 ADD 视图中添加并保存您的用户画像。', true);
                isFilling = false;
                chrome.storage.local.set({ isFilling: false });
                chrome.storage.sync.set({ isFilling: false });
                updateUI();
                return;
            }

            // 获取并发送消息
            (async () => {
                // 从storage中重新获取最新的开关状态，确保准确性
                const localSettings = await new Promise(res => chrome.storage.local.get([MEM0_ENABLE_KEY, CORRECTION_KEY, CORRECTION_TS_KEY], res));
                const syncSettings = await new Promise(res => chrome.storage.sync.get([MEM0_ENABLE_KEY, CORRECTION_KEY, CORRECTION_TS_KEY], res));
                
                const mem0Enable = !!(syncSettings[MEM0_ENABLE_KEY] !== undefined ? syncSettings[MEM0_ENABLE_KEY] : localSettings[MEM0_ENABLE_KEY]);
                
                // Compare timestamps to get the definitive most recent value for correctionEnabled
                const localTs = localSettings[CORRECTION_TS_KEY] || 0;
                const syncTs = syncSettings[CORRECTION_TS_KEY] || 0;
                const correctionEnabled = !!(syncTs > localTs ? syncSettings[CORRECTION_KEY] : localSettings[CORRECTION_KEY]);

                let mem0Params = {};

                if (mem0Enable) {
                    try {
                        mem0Params = await getMem0Parameters();
                    } catch (error) {
                        showStatus(error.message + '，请填写。', true);
                        openMem0ParamModal(); // 仅弹窗提示，不执行后续操作
                        // 中断填充流程
                        isFilling = false;
                        chrome.storage.local.set({ isFilling: false });
                        chrome.storage.sync.set({ isFilling: false });
                        updateUI();
                        return;
                    }
                }

                chrome.tabs.sendMessage(tab.id, {
                    type: 'start-filling',
                    payload: {
                        profile: userProfile,
                        model: selectedModel || 'gpt-4.1',
                        mem0Enable,
                        correctionEnabled, // 添加纠错开关状态
                        ...mem0Params
                    }
                });
            })();

        } catch (e) {
            showStatus(`启动失败: ${e.message}`, true);
            isFilling = false;
            chrome.storage.local.set({ isFilling: false });
            chrome.storage.sync.set({ isFilling: false });
            updateUI();
        }
    });

    // Stop Filling button
    stopFillingButton.addEventListener('click', async () => {
        isFilling = false;
        chrome.storage.local.set({ isFilling: false });
        chrome.storage.sync.set({ isFilling: false });
        updateUI();
        showStatus('正在发送停止指令...');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                chrome.tabs.sendMessage(tab.id, { type: 'stop-filling' });
                showStatus('已发送停止指令。');
            }
        } catch (e) {
            console.error("发送停止指令失败:", e);
            showStatus(`停止时出错: ${e.message}`, true);
        }
    });

    // --- Initialization ---
    // Load settings and update the UI accordingly
    loadSettings();
    // The updateUI() call is now inside loadSettings to ensure correct order
});
