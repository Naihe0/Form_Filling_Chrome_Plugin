/**
 * ProviderRegistry - LLM service-provider configuration.
 *
 * Each provider defines an API endpoint URL and a sensible default model.
 * The popup uses getProviderList() to render the dropdown;
 * the background service worker has its own copy of the endpoint map.
 */
const ProviderRegistry = (() => {
  const providers = {
    openrouter: {
      name: 'OpenRouter',
      defaultModel: 'openai/gpt-5.2',
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    },
    openai: {
      name: 'OpenAI',
      defaultModel: 'gpt-5.2',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
    },
    gemini: {
      name: 'Gemini',
      defaultModel: 'gemini-3-flash-preview',
      apiUrl:
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    },
    qwen: {
      name: 'Qwen',
      defaultModel: 'qwen3.5-plus',
      apiUrl:
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    },
  };

  /** Get a provider object by id. */
  function getProvider(id) {
    return providers[id] || null;
  }

  /** Return an array of { id, name, defaultModel } for every provider. */
  function getProviderList() {
    return Object.entries(providers).map(([id, p]) => ({
      id,
      name: p.name,
      defaultModel: p.defaultModel,
    }));
  }

  /** Return the default model id for a provider. */
  function getDefaultModel(providerId) {
    return providers[providerId]?.defaultModel || '';
  }

  return { getProvider, getProviderList, getDefaultModel };
})();
