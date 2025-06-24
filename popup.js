document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('apiKey');
    const userProfileInput = document.getElementById('userProfile');
    const saveButton = document.getElementById('saveButton');
    const fillButton = document.getElementById('fillButton');
    const statusDiv = document.getElementById('status');

    // Load saved settings
    chrome.storage.local.get(['apiKey', 'userProfile'], (result) => {
        if (result.apiKey) {
            apiKeyInput.value = result.apiKey;
        }
        if (result.userProfile) {
            userProfileInput.value = result.userProfile;
        }
    });

    // Save settings
    saveButton.addEventListener('click', () => {
        const apiKey = apiKeyInput.value;
        const userProfile = userProfileInput.value;
        chrome.storage.local.set({ apiKey, userProfile }, () => {
            statusDiv.textContent = '配置已保存！';
            setTimeout(() => statusDiv.textContent = '', 2000);
        });
    });

    // Start filling
    fillButton.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (tab) {
            statusDiv.textContent = '正在注入脚本...';
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });
                statusDiv.textContent = '脚本已注入，开始填充...';
                // The content script will now take over.
            } catch (e) {
                console.error("脚本注入失败:", e);
                statusDiv.textContent = `错误: ${e.message}`;
            }
        }
    });
});