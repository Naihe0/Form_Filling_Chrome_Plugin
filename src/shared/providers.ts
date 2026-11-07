/**
 * LLM provider registry: the single source of truth for endpoints and defaults.
 *
 * All providers speak the OpenAI chat-completions dialect. `params` are sent on
 * every request; the gateway drops any parameter a model rejects, so a user can
 * type any model id without the registry having to know what it supports.
 */

export type ProviderId = 'openrouter' | 'openai' | 'gemini' | 'qwen';
export type ResponseFormat = 'json_schema' | 'json_object' | 'none';

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  chatUrl: string;
  defaultModel: string;
  format: ResponseFormat;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openai/gpt-5.2',
    format: 'json_schema',
    params: { reasoning: { effort: 'low' } },
    headers: { 'HTTP-Referer': 'chrome-extension://ai-form-filler' },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-5.2',
    format: 'json_schema',
    params: { reasoning_effort: 'low' },
    headers: {},
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    // An alias, so the default survives Google retiring dated flash versions.
    defaultModel: 'gemini-flash-latest',
    format: 'json_schema',
    // Default thinking costs ~25x the latency and ~50x the tokens on form tasks.
    params: { reasoning_effort: 'low' },
    headers: {},
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen',
    chatUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen3.5-plus',
    format: 'json_object',
    params: {},
    headers: {},
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && value in PROVIDERS;
}
