document.addEventListener('DOMContentLoaded', () => {
    // --- Element References ---
    // Views
    const addView = document.getElementById('add-view');
    const fillView = document.getElementById('fill-view');
    const fillingView = document.getElementById('filling-view');
    const topButtonContainer = document.getElementById('top-button-container');

    // ADD View elements
    const profileDisplay = document.getElementById('profileDisplay');
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
     * Shows a status message for a short duration.
     * @param {string} message - The message to display.
     * @param {boolean} isError - If true, formats as an error.
     */
    function showStatus(message, isError = false) {
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
        
        // Save to chrome.storage and then update the UI
        chrome.storage.local.set({ userProfile }, () => {
            profileDisplay.value = userProfile;
            userProfileInput.value = ''; // Clear input field after saving
            showStatus('用户画像已保存！');
        });
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
        return true;
    }

    /**
     * Saves the selected model to storage.
     */
    function saveModel() {
        const selectedModel = modelSelect.value;
        chrome.storage.local.set({ selectedModel });
    }

    /**
     * Loads all settings from chrome.storage when the popup opens.
     */
    function loadSettings() {
        chrome.storage.local.get(['apiKey', 'userProfile', 'selectedModel', 'isFilling'], (result) => {
            if (result.apiKey) {
                apiKeyInput.value = result.apiKey;
            }
            if (result.userProfile) {
                profileDisplay.textContent = result.userProfile;
            }
            if (result.selectedModel) {
                modelSelect.value = result.selectedModel;
            }
            // Restore the filling state
            isFilling = result.isFilling || false;
            updateUI(); // Update UI after loading the state
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
        chrome.storage.local.set({ isFilling: true }); // Persist state
        updateUI();
        showStatus('正在开始填充...');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            // --- SCRIPT INJECTION ---
            // In Manifest V3, we must programmatically inject scripts.
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['fieldProcessor.js', 'content.js']
            });

            const { userProfile, selectedModel } = await chrome.storage.local.get(['userProfile', 'selectedModel']);

            if (!userProfile) {
                showStatus('请先在 ADD 视图中添加并保存您的用户画像。', true);
                isFilling = false;
                chrome.storage.local.set({ isFilling: false }); // Persist state
                updateUI();
                return;
            }

            // Send a message to the content script to start the process
            chrome.tabs.sendMessage(tab.id, {
                type: 'start-filling',
                payload: {
                    profile: userProfile,
                    model: selectedModel || 'gpt-4o' // Pass the selected model
                }
            });

        } catch (e) {
            console.error("Error starting fill process:", e);
            showStatus(`启动失败: ${e.message}`, true);
            isFilling = false;
            chrome.storage.local.set({ isFilling: false }); // Persist state
            updateUI();
        }
    });
    
    // Stop Filling button
    stopFillingButton.addEventListener('click', async () => {
        isFilling = false;
        chrome.storage.local.set({ isFilling: false }); // Persist state
        updateUI();
        showStatus('正在发送停止指令...');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                chrome.tabs.sendMessage(tab.id, { type: 'stop-filling' });
                showStatus('已发送停止指令。');
            }
        } catch(e) {
            console.error("发送停止指令失败:", e);
            showStatus(`停止时出错: ${e.message}`, true);
        }
    });

    // --- Initialization ---
    // Load settings and update the UI accordingly
    loadSettings();
    // The updateUI() call is now inside loadSettings to ensure correct order
});
