/**
 * Content Script - Main Entry Point
 *
 * Orchestrates form filling and the "quick query" feature.
 * Loaded after lib/i18n.js, lib/storage.js, statusUI.js,
 * fieldExtractor.js, and fieldProcessor.js (all share the same
 * isolated content-script world).
 */
(async function () {
  'use strict';

  /* ================================================================== */
  /* LLM Configuration (per-session, set when a command arrives)        */
  /* ================================================================== */

  const LLMConfig = {
    provider: 'openai',
    model: 'gpt-4.1',
    apiKey: '',

    /** Merge partial config into current settings. */
    set(cfg) {
      if (cfg.provider) this.provider = cfg.provider;
      if (cfg.model) this.model = cfg.model;
      if (cfg.apiKey) this.apiKey = cfg.apiKey;
    },
  };

  /* ================================================================== */
  /* askLLM - Bridge to the background service worker                   */
  /* ================================================================== */

  /**
   * Send a prompt to the LLM via the background service worker.
   * @param {string}  prompt         - The prompt text.
   * @param {string} [modelOverride] - Optional model id that overrides config.
   * @returns {Promise<any>} Parsed response (object, array, or string).
   */
  async function askLLM(prompt, modelOverride) {
    const { provider, apiKey } = LLMConfig;
    const model = modelOverride || LLMConfig.model;

    if (!apiKey) {
      alert(I18n.t('csApiKeyMissing'));
      throw new Error('API Key not found.');
    }

    const llmPromise = new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'llm-request', payload: { prompt, provider, model, apiKey } },
        (response) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (response.success) {
            try {
              resolve(JSON.parse(response.data));
            } catch {
              resolve(response.data);
            }
          } else {
            reject(new Error(response.error));
          }
        }
      );
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LLM request timed out (90 s).')), 90000)
    );

    return Promise.race([llmPromise, timeoutPromise]);
  }

  /* ================================================================== */
  /* FormFillerAgent                                                     */
  /* ================================================================== */

  class FormFillerAgent {
    constructor() {
      this.filledFields = new Set();
      this.isStopped = false;
      this.statusUI = new StatusUI();
    }

    async start(payload) {
      this.statusUI.update(I18n.t('csStarting'));

      try {
        const { profile, provider, model, apiKey, correctionEnabled } = payload;

        // Configure LLM for this run
        LLMConfig.set({ provider, model, apiKey });

        // Verify that required modules are loaded
        if (typeof FieldExtractor === 'undefined' || typeof FieldProcessor === 'undefined') {
          console.error('CRITICAL: FieldExtractor or FieldProcessor not loaded.');
          this.statusUI.update(I18n.t('csModuleError'));
          return;
        }

        FieldExtractor.init({
          statusUI: this.statusUI,
          askLLM,
          isStopped: () => this.isStopped,
        });

        FieldProcessor.init({
          statusUI: this.statusUI,
          successfullyFilledFields: this.filledFields,
          askLLM,
          correctionEnabled: !!correctionEnabled,
        });

        // InteractionHandler for multi-step interactive fields
        if (typeof InteractionHandler !== 'undefined') {
          InteractionHandler.init({
            askLLM,
            statusUI: this.statusUI,
          });
        }

        if (!profile) {
          alert(I18n.t('csNoProfile'));
          this.statusUI.update(I18n.t('csNoProfile'));
          return;
        }

        // Main filling loop (currently single-page)
        let pageChanged = true;
        while (pageChanged) {
          if (this.isStopped) break;

          // 1 ── Extract fields
          this.statusUI.startTimer(I18n.t('csExtractingFields'));
          const allFields = await FieldExtractor.extractFields();
          this.statusUI.stopTimer();

          if (this.isStopped) break;

          if (!allFields || allFields.length === 0) {
            this.statusUI.update(I18n.t('csNoFields'));
          } else {
            const toFill = allFields.filter((f) => !this.filledFields.has(f.selector));

            if (toFill.length > 0) {
              // 2 ── Assign values via LLM
              this.statusUI.startTimer(
                I18n.t('csAnalyzing', { count: toFill.length })
              );
              const withValues = await FieldExtractor.addValuesToFields(toFill, profile);
              this.statusUI.stopTimer();

              if (this.isStopped) break;

              // 3 ── Fill each field
              let filled = 0;
              for (const field of withValues) {
                if (this.isStopped) break;
                if (field.value != null) {
                  filled++;
                  this.statusUI.update(
                    I18n.t('csFilling', {
                      current: filled,
                      total: toFill.length,
                      question: field.question,
                    })
                  );
                  await FieldProcessor.processSingleField(field, field.value, profile);
                }
              }
            } else {
              this.statusUI.update(I18n.t('csAllFilled'));
            }
          }

          if (this.isStopped) break;
          pageChanged = false; // single-page fill
        }

        // Final status
        if (this.isStopped) {
          this.statusUI.update(I18n.t('csStopped'));
        } else {
          alert(I18n.t('csCompleteAlert'));
          this.statusUI.update(I18n.t('csComplete'));
        }
      } catch (e) {
        console.error('Form filling error:', e);
        this.statusUI.update(I18n.t('csError'));
      } finally {
        StorageManager.set({ isFilling: false });
        setTimeout(() => this.statusUI.remove(), 3000);
      }
    }
  }

  /* ================================================================== */
  /* QuickQueryHandler                                                   */
  /* ================================================================== */

  class QuickQueryHandler {
    constructor(options) {
      this.userProfile = options.userProfile;
      this.askLLM = options.askLLM;
      this.statusUI = null;
      this.activeElement = null;

      // Bind handlers so they can be removed cleanly
      this.handleFocus = this.handleFocus.bind(this);
      this.handleBlur = this.handleBlur.bind(this);
      this.handleInput = this.handleInput.bind(this);
    }

    start() {
      document.addEventListener('focus', this.handleFocus, true);
      document.addEventListener('blur', this.handleBlur, true);
    }

    stop() {
      document.removeEventListener('focus', this.handleFocus, true);
      document.removeEventListener('blur', this.handleBlur, true);
      if (this.activeElement) {
        this.activeElement.removeEventListener('input', this.handleInput);
      }
    }

    handleFocus(event) {
      const t = event.target;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) {
        if (this.activeElement) {
          this.activeElement.removeEventListener('input', this.handleInput);
        }
        this.activeElement = t;
        this.activeElement.addEventListener('input', this.handleInput);
      }
    }

    handleBlur(event) {
      if (this.activeElement === event.target) {
        this.activeElement.removeEventListener('input', this.handleInput);
        this.activeElement = null;
      }
    }

    handleInput(event) {
      const el = event.target;
      const val = el.isContentEditable ? el.textContent : el.value;
      if (val && (val.endsWith('```') || val.endsWith('···'))) {
        setTimeout(() => this._triggerQuery(el, val), 0);
      }
    }

    async _triggerQuery(element, currentValue) {
      const query = currentValue.slice(0, -3);
      this.statusUI = new StatusUI();
      this.statusUI.startTimer(I18n.t('csGenerating'));

      try {
        const prompt = `用户的个人信息（用户画像）如下:
---
${this.userProfile}
---

用户当前正在一个表单字段中，并输入了以下内容:
---
${query}
---

请根据用户的个人信息和已有输入，生成一个合适内容。
请直接返回最终的文本结果，不要包含任何额外的解释或标记。`;

        const response = await this.askLLM(prompt);
        const result = typeof response === 'string' ? response : response.answer || '';

        this._setElementValue(element, query + result);
        this.statusUI.update(I18n.t('csGenerated'));
      } catch (e) {
        console.error('Quick query failed:', e);
        this.statusUI.update(I18n.t('csGenerateFailed') + e.message);
      } finally {
        if (this.statusUI) {
          setTimeout(() => {
            this.statusUI.remove();
            this.statusUI = null;
          }, 3000);
        }
      }
    }

    _setElementValue(element, value) {
      if (element.isContentEditable) {
        element.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
        return;
      }
      const proto = Object.getPrototypeOf(element);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /* ================================================================== */
  /* Initialisation                                                      */
  /* ================================================================== */

  // Load the user's preferred language
  await I18n.init();

  /** Auto-start Quick Query if it was previously enabled. */
  async function initQuickQuery() {
    try {
      const data = await StorageManager.get([
        'quick_query_enabled',
        'userProfile',
        'selectedProvider',
        'providerConfigs',
        'userProfile_ts',
      ]);

      if (!data.quick_query_enabled) return;

      const provider = data.selectedProvider || 'openai';
      const configs = data.providerConfigs || {};
      const providerCfg = configs[provider] || {};

      if (!data.userProfile || !providerCfg.apiKey) return;

      LLMConfig.set({
        provider,
        model: providerCfg.modelId || 'gpt-4.1',
        apiKey: providerCfg.apiKey,
      });

      if (window.quickQueryHandler) window.quickQueryHandler.stop();

      window.quickQueryHandler = new QuickQueryHandler({
        userProfile: data.userProfile,
        askLLM,
      });
      window.quickQueryHandler.start();
    } catch (e) {
      console.error('Quick query init error:', e);
    }
  }

  /* ================================================================== */
  /* Message Listener                                                    */
  /* ================================================================== */

  chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
    if (request.type === 'start-filling') {
      if (window.formFillerAgent && !window.formFillerAgent.isStopped) return;
      window.formFillerAgent = new FormFillerAgent();
      window.formFillerAgent.start(request.payload);
    } else if (request.type === 'stop-filling') {
      if (window.formFillerAgent) {
        window.formFillerAgent.isStopped = true;
      }
    } else if (request.type === 'toggle-quick-query') {
      const { enabled, profile, provider, model, apiKey } = request.payload;
      if (enabled) {
        LLMConfig.set({ provider, model, apiKey });
        if (window.quickQueryHandler) window.quickQueryHandler.stop();
        window.quickQueryHandler = new QuickQueryHandler({
          userProfile: profile,
          askLLM,
        });
        window.quickQueryHandler.start();
      } else {
        if (window.quickQueryHandler) {
          window.quickQueryHandler.stop();
          window.quickQueryHandler = null;
        }
      }
    }
    return true; // keep message channel open
  });

  // Kick off auto-init
  initQuickQuery();
})();
