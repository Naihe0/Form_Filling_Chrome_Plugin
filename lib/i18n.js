/**
 * I18n - Internationalization Module
 * Supports runtime language switching between English and Chinese.
 * Used by both popup and content scripts via IIFE global.
 */
const I18n = (() => {
  const translations = {
    en: {
      // Header
      extensionName: 'AI Form Filler',

      // Tabs
      tabProfile: 'Profile',
      tabFill: 'Fill',

      // Profile view
      profilePlaceholder: 'Your saved user profile will appear here...',
      profileInputPlaceholder: 'Enter profile information...',
      editBtn: 'Edit',
      saveBtn: 'Save',
      profileSaved: 'Profile saved!',
      profileUpdated: 'Profile updated!',
      profileEmpty: 'Profile cannot be empty!',

      // Fill view — Provider config
      serviceProvider: 'Service Provider',
      modelId: 'Model ID',
      apiKey: 'API Key',
      apiKeyPlaceholder: 'Enter your API key',
      modelIdPlaceholder: 'e.g., ',

      // Feature toggles
      quickQuery: 'Quick Query',
      reasoningCorrection: 'Reasoning Correction',

      // Action buttons
      startFilling: 'Start Filling',
      stopFilling: 'Stop Filling',

      // Popup status messages
      statusStarting: 'Starting form filling...',
      statusStopping: 'Sending stop command...',
      statusStopped: 'Stop command sent.',
      statusNoProfile: 'Please add your profile in the Profile tab first.',
      statusNoApiKey: 'Please enter your API key.',
      statusLaunchFailed: 'Launch failed: ',
      statusQuickQuerySetup: 'Set up profile and API key before using Quick Query.',
      statusQuickQueryFailed: 'Quick Query toggle failed: ',

      // Content-script status messages
      csStarting: '🚀 Starting form filling...',
      csModuleError: '❌ Critical: Module load failed!',
      csNoProfile: 'Please set your user profile in the extension popup.',
      csExtractingFields: '🔍 Extracting page fields',
      csNoFields: '🤔 No fillable fields found.',
      csAnalyzing: '🧠 Analyzing values for {count} fields',
      csFilling: '✍️ Filling ({current}/{total}): {question}',
      csAllFilled: '👍 All fields filled.',
      csStopped: '🛑 Filling stopped.',
      csComplete: '✅ Form filling complete!',
      csCompleteAlert:
        'Form filling complete!\n\nPlease review all content carefully — AI results may contain errors.',
      csError: '❌ Error occurred, check console.',
      csFieldFailed: '❌ Field "{question}" failed',
      csCorrecting: '🤔 Attempting correction...',
      csCorrectionSuccess: '✅ Correction succeeded, retrying "{question}"...',
      csGroupCorrecting: '🤔 Option group failed, correcting...',
      csInteracting: '🔄 Interacting with widget: {question}',
      csInteractingLLM: '🧠 Analyzing widget: {question}',
      csGenerating: '🚀 Generating content...',
      csGenerated: '✅ Content generated!',
      csGenerateFailed: '❌ Quick query failed: ',
      csApiKeyMissing: 'Please set your API key in the extension popup.',
    },

    zh_CN: {
      extensionName: 'AI 智能填表助手',

      tabProfile: '画像',
      tabFill: '填充',

      profilePlaceholder: '已保存的用户画像将显示在这里...',
      profileInputPlaceholder: '输入您的用户画像信息...',
      editBtn: '编辑',
      saveBtn: '保存',
      profileSaved: '用户画像已保存！',
      profileUpdated: '用户画像已更新！',
      profileEmpty: '用户画像内容不能为空！',

      serviceProvider: '服务商',
      modelId: '模型 ID',
      apiKey: 'API 密钥',
      apiKeyPlaceholder: '输入您的 API 密钥',
      modelIdPlaceholder: '例如 ',

      quickQuery: '快捷问询',
      reasoningCorrection: '推理纠错',

      startFilling: '开始填充',
      stopFilling: '停止填充',

      statusStarting: '正在开始填充...',
      statusStopping: '正在发送停止指令...',
      statusStopped: '已发送停止指令。',
      statusNoProfile: '请先在画像页中添加并保存您的用户画像。',
      statusNoApiKey: '请输入您的 API 密钥。',
      statusLaunchFailed: '启动失败：',
      statusQuickQuerySetup: '使用快捷问询前，请先设置用户画像和 API 密钥。',
      statusQuickQueryFailed: '快捷问询切换失败：',

      csStarting: '🚀 开始填充表单...',
      csModuleError: '❌ 关键错误：模块加载失败！',
      csNoProfile: '请先在插件弹窗中设置您的用户画像。',
      csExtractingFields: '🔍 正在提取页面字段',
      csNoFields: '🤔 未找到可填充字段。',
      csAnalyzing: '🧠 正在为 {count} 个字段分析填充值',
      csFilling: '✍️ 正在填充 ({current}/{total}): {question}',
      csAllFilled: '👍 所有字段均已填充。',
      csStopped: '🛑 填充已中断。',
      csComplete: '✅ 表单填充完成！',
      csCompleteAlert:
        '表单填充完成！\n\n请仔细检查所有表单内容，LLM自动填写结果可能存在误差。',
      csError: '❌ 发生错误，请查看控制台。',
      csFieldFailed: '❌ 字段 "{question}" 填充失败',
      csCorrecting: '🤔 填充失败，尝试纠错...',
      csCorrectionSuccess: '✅ 纠错成功，正在重试 "{question}"...',
      csGroupCorrecting: '🤔 选项组填充失败，尝试纠错...',
      csInteracting: '🔄 正在与组件交互：{question}',
      csInteractingLLM: '🧠 正在分析组件：{question}',
      csGenerating: '🚀 正在为您生成内容...',
      csGenerated: '✅ 内容已生成并填充！',
      csGenerateFailed: '❌ 快捷问询失败：',
      csApiKeyMissing: '请先在插件弹窗中设置您的 API 密钥。',
    },
  };

  let currentLang = 'en';

  /** Set the active language ('en' | 'zh_CN'). */
  function setLanguage(lang) {
    currentLang = lang;
  }

  /** Return the active language code. */
  function getLanguage() {
    return currentLang;
  }

  /**
   * Translate a key, optionally interpolating {param} placeholders.
   * Falls back to the English value, then the raw key.
   */
  function t(key, params = {}) {
    const dict = translations[currentLang] || translations.en;
    let text = dict[key] || translations.en[key] || key;
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, v);
    }
    return text;
  }

  /**
   * Walk the DOM and apply translations to elements with
   * data-i18n, data-i18n-placeholder, or data-i18n-title attributes.
   */
  function applyToDOM(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
  }

  /**
   * Load the user's preferred language from storage (or detect from browser).
   * Returns a promise that resolves with the active language code.
   */
  async function init() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(['language'], (result) => {
          if (result.language) {
            currentLang = result.language;
          } else {
            const browserLang = (navigator.language || '').toLowerCase();
            currentLang = browserLang.startsWith('zh') ? 'zh_CN' : 'en';
          }
          resolve(currentLang);
        });
      } else {
        resolve(currentLang);
      }
    });
  }

  return { setLanguage, getLanguage, t, applyToDOM, init };
})();
