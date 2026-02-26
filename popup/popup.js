/**
 * Popup Script - Extension popup UI logic.
 *
 * Handles:
 *  - Runtime language switching (EN / 中文)
 *  - Profile management (add / edit / save)
 *  - Per-provider configuration (API key & model ID saved per provider)
 *  - Feature toggles (Quick Query, Reasoning Correction)
 *  - Start / Stop form filling
 */
document.addEventListener('DOMContentLoaded', async () => {
  /* ================================================================ */
  /* i18n Initialisation                                               */
  /* ================================================================ */

  await I18n.init();
  I18n.applyToDOM();

  /* ================================================================ */
  /* Element References                                                */
  /* ================================================================ */

  const tabProfile = document.getElementById('tabProfile');
  const tabFill = document.getElementById('tabFill');
  const viewProfile = document.getElementById('view-profile');
  const viewFill = document.getElementById('view-fill');
  const viewFilling = document.getElementById('view-filling');
  const tabBar = document.getElementById('tab-bar');

  const profileDisplay = document.getElementById('profileDisplay');
  const profileInput = document.getElementById('profileInput');
  const editProfileBtn = document.getElementById('editProfileBtn');
  const saveProfileBtn = document.getElementById('saveProfileBtn');

  const providerSelect = document.getElementById('providerSelect');
  const modelIdInput = document.getElementById('modelIdInput');
  const apiKeyInput = document.getElementById('apiKeyInput');

  const quickQueryToggle = document.getElementById('quickQueryToggle');
  const correctionToggle = document.getElementById('correctionToggle');

  const startFillingBtn = document.getElementById('startFillingBtn');
  const stopFillingBtn = document.getElementById('stopFillingBtn');
  const statusDiv = document.getElementById('status');

  const langEnBtn = document.getElementById('langEn');
  const langZhBtn = document.getElementById('langZh');

  /* ================================================================ */
  /* State                                                              */
  /* ================================================================ */

  let currentView = 'fill'; // 'profile' | 'fill'
  let isFilling = false;
  let isEditing = false;

  /**
   * Per-provider configuration map.
   * Shape: { [providerId]: { apiKey: string, modelId: string } }
   */
  let providerConfigs = {};

  /* ================================================================ */
  /* Language Switching                                                 */
  /* ================================================================ */

  function updateLangButtons() {
    const lang = I18n.getLanguage();
    langEnBtn.classList.toggle('active', lang === 'en');
    langZhBtn.classList.toggle('active', lang === 'zh_CN');
  }
  updateLangButtons();

  /** Refresh all translatable text after a language change. */
  function refreshI18n() {
    I18n.applyToDOM();
    updateLangButtons();
    editProfileBtn.textContent = isEditing ? I18n.t('saveBtn') : I18n.t('editBtn');
    _loadProviderUI(providerSelect.value); // re-set dynamic placeholder
  }

  langEnBtn.addEventListener('click', async () => {
    I18n.setLanguage('en');
    await StorageManager.set({ language: 'en' });
    refreshI18n();
  });

  langZhBtn.addEventListener('click', async () => {
    I18n.setLanguage('zh_CN');
    await StorageManager.set({ language: 'zh_CN' });
    refreshI18n();
  });

  /* ================================================================ */
  /* View / Tab Management                                             */
  /* ================================================================ */

  function updateView() {
    viewProfile.classList.add('hidden');
    viewFill.classList.add('hidden');
    viewFilling.classList.add('hidden');

    tabBar.style.display = isFilling ? 'none' : 'flex';

    if (isFilling) {
      viewFilling.classList.remove('hidden');
    } else if (currentView === 'profile') {
      viewProfile.classList.remove('hidden');
      tabProfile.classList.add('active');
      tabFill.classList.remove('active');
    } else {
      viewFill.classList.remove('hidden');
      tabFill.classList.add('active');
      tabProfile.classList.remove('active');
    }
  }

  tabProfile.addEventListener('click', () => {
    if (isFilling) return;
    currentView = 'profile';
    updateView();
  });

  tabFill.addEventListener('click', () => {
    if (isFilling) return;
    currentView = 'fill';
    updateView();
  });

  /* ================================================================ */
  /* Status Display                                                    */
  /* ================================================================ */

  function showStatus(msg, isError = false) {
    statusDiv.textContent = msg;
    statusDiv.className = isError ? 'status error' : 'status';
    setTimeout(() => {
      statusDiv.textContent = '';
    }, 3000);
  }

  /* ================================================================ */
  /* Profile Management                                                */
  /* ================================================================ */

  editProfileBtn.addEventListener('click', () => {
    if (!isEditing) {
      profileDisplay.readOnly = false;
      profileDisplay.focus();
      editProfileBtn.textContent = I18n.t('saveBtn');
      isEditing = true;
    } else {
      profileDisplay.readOnly = true;
      editProfileBtn.textContent = I18n.t('editBtn');
      isEditing = false;
      _saveProfileText(profileDisplay.value);
      showStatus(I18n.t('profileUpdated'));
    }
  });

  saveProfileBtn.addEventListener('click', () => {
    const text = profileInput.value.trim();
    if (!text) {
      showStatus(I18n.t('profileEmpty'), true);
      return;
    }
    _appendProfile(text);
    profileInput.value = '';
    showStatus(I18n.t('profileSaved'));
  });

  function _saveProfileText(text) {
    const ts = Date.now();
    try {
      let arr = JSON.parse(text);
      if (!Array.isArray(arr)) arr = [text];
      StorageManager.set({ userProfile: JSON.stringify(arr), userProfile_ts: ts });
    } catch {
      const arr = text
        .split(/\n---\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      StorageManager.set({ userProfile: JSON.stringify(arr), userProfile_ts: ts });
    }
  }

  async function _appendProfile(text) {
    const data = await StorageManager.get(['userProfile', 'userProfile_ts']);
    let history = [];
    if (data.userProfile) {
      try {
        history = JSON.parse(data.userProfile);
        if (!Array.isArray(history)) history = [data.userProfile];
      } catch {
        history = [data.userProfile];
      }
    }
    history.push(text);
    const ts = Date.now();
    await StorageManager.set({ userProfile: JSON.stringify(history), userProfile_ts: ts });
    profileDisplay.value = history.join('\n---\n');
  }

  /* ================================================================ */
  /* Provider Configuration                                            */
  /* ================================================================ */

  /** Persist current inputs into the providerConfigs map and storage. */
  function _saveCurrentProviderConfig() {
    const provider = providerSelect.value;
    providerConfigs[provider] = {
      apiKey: apiKeyInput.value.trim(),
      modelId: modelIdInput.value.trim(),
    };
    StorageManager.set({
      selectedProvider: provider,
      providerConfigs,
    });
  }

  /** Load the saved config for the given provider into the form fields. */
  function _loadProviderUI(provider) {
    const config = providerConfigs[provider] || {};
    const defaultModel = ProviderRegistry.getDefaultModel(provider);
    modelIdInput.value = config.modelId || '';
    modelIdInput.placeholder = I18n.t('modelIdPlaceholder') + defaultModel;
    apiKeyInput.value = config.apiKey || '';
  }

  providerSelect.addEventListener('change', () => {
    _saveCurrentProviderConfig();
    _loadProviderUI(providerSelect.value);
  });

  // Save on blur so data isn't lost when user clicks "Start Filling"
  modelIdInput.addEventListener('change', _saveCurrentProviderConfig);
  apiKeyInput.addEventListener('change', _saveCurrentProviderConfig);

  /* ================================================================ */
  /* Toggle Handlers                                                   */
  /* ================================================================ */

  quickQueryToggle.addEventListener('change', async () => {
    const checked = quickQueryToggle.checked;
    await StorageManager.set({ quick_query_enabled: checked });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      // Inject content scripts if not yet present
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [
            'lib/i18n.js',
            'lib/storage.js',
            'content/statusUI.js',
            'content/fieldExtractor.js',
            'content/fieldProcessor.js',
            'content/main.js',
          ],
        });
      } catch {
        /* already injected */
      }

      if (checked) {
        const data = await StorageManager.get(['userProfile', 'userProfile_ts']);
        const provider = providerSelect.value;
        const config = providerConfigs[provider] || {};

        if (!data.userProfile || !config.apiKey) {
          showStatus(I18n.t('statusQuickQuerySetup'), true);
          quickQueryToggle.checked = false;
          await StorageManager.set({ quick_query_enabled: false });
          return;
        }

        chrome.tabs.sendMessage(tab.id, {
          type: 'toggle-quick-query',
          payload: {
            enabled: true,
            profile: data.userProfile,
            provider,
            model: config.modelId || ProviderRegistry.getDefaultModel(provider),
            apiKey: config.apiKey,
          },
        });
      } else {
        chrome.tabs.sendMessage(tab.id, {
          type: 'toggle-quick-query',
          payload: { enabled: false },
        });
      }
    } catch (e) {
      showStatus(I18n.t('statusQuickQueryFailed') + e.message, true);
    }
  });

  correctionToggle.addEventListener('change', async () => {
    const ts = Date.now();
    await StorageManager.set({
      correction_enabled: correctionToggle.checked,
      correction_enabled_ts: ts,
    });
  });

  /* ================================================================ */
  /* Start / Stop Filling                                              */
  /* ================================================================ */

  startFillingBtn.addEventListener('click', async () => {
    _saveCurrentProviderConfig();

    const provider = providerSelect.value;
    const config = providerConfigs[provider] || {};

    if (!config.apiKey) {
      showStatus(I18n.t('statusNoApiKey'), true);
      return;
    }

    isFilling = true;
    await StorageManager.set({ isFilling: true });
    updateView();
    showStatus(I18n.t('statusStarting'));

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const data = await StorageManager.get(['userProfile', 'userProfile_ts']);

      if (!data.userProfile) {
        showStatus(I18n.t('statusNoProfile'), true);
        isFilling = false;
        await StorageManager.set({ isFilling: false });
        updateView();
        return;
      }

      const corrData = await StorageManager.get([
        'correction_enabled',
        'correction_enabled_ts',
      ]);

      chrome.tabs.sendMessage(tab.id, {
        type: 'start-filling',
        payload: {
          profile: data.userProfile,
          provider,
          model: config.modelId || ProviderRegistry.getDefaultModel(provider),
          apiKey: config.apiKey,
          correctionEnabled: !!corrData.correction_enabled,
        },
      });
    } catch (e) {
      showStatus(I18n.t('statusLaunchFailed') + e.message, true);
      isFilling = false;
      await StorageManager.set({ isFilling: false });
      updateView();
    }
  });

  stopFillingBtn.addEventListener('click', async () => {
    isFilling = false;
    await StorageManager.set({ isFilling: false });
    updateView();
    showStatus(I18n.t('statusStopping'));

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: 'stop-filling' });
        showStatus(I18n.t('statusStopped'));
      }
    } catch (e) {
      showStatus(I18n.t('statusLaunchFailed') + e.message, true);
    }
  });

  /* ================================================================ */
  /* Load Settings from Storage                                        */
  /* ================================================================ */

  async function loadSettings() {
    const data = await StorageManager.get([
      'userProfile',
      'userProfile_ts',
      'selectedProvider',
      'providerConfigs',
      'isFilling',
      'quick_query_enabled',
      'correction_enabled',
      'correction_enabled_ts',
      'language',
    ]);

    // Provider configs
    providerConfigs = data.providerConfigs || {};
    const provider = data.selectedProvider || 'openai';
    providerSelect.value = provider;
    _loadProviderUI(provider);

    // Profile
    if (data.userProfile) {
      try {
        let arr = JSON.parse(data.userProfile);
        if (!Array.isArray(arr)) arr = [data.userProfile];
        profileDisplay.value = arr.join('\n---\n');
      } catch {
        profileDisplay.value = data.userProfile;
      }
    }

    // Toggles
    quickQueryToggle.checked = !!data.quick_query_enabled;
    correctionToggle.checked = !!data.correction_enabled;

    // Filling state
    isFilling = !!data.isFilling;
    updateView();
  }

  await loadSettings();
});
