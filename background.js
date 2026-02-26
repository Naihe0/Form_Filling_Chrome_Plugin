/**
 * Background Service Worker
 *
 * Proxies LLM API requests from content scripts to the appropriate
 * provider endpoint.  Keeps API keys secure — they never leave the
 * service-worker context in outbound headers visible to web pages.
 */

/* ------------------------------------------------------------------ */
/* Provider Endpoint Map                                               */
/* ------------------------------------------------------------------ */

const PROVIDER_ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini:
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
};

/* ------------------------------------------------------------------ */
/* Cumulative token-usage tracking (per service-worker lifetime)       */
/* ------------------------------------------------------------------ */

const tokenStats = { input: 0, output: 0 };

/* ------------------------------------------------------------------ */
/* Message Listener                                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'llm-request') {
    const { prompt, provider, model, apiKey } = request.payload;
    callLLM(prompt, provider, model, apiKey)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }
});

/* ------------------------------------------------------------------ */
/* Core LLM Call                                                       */
/* ------------------------------------------------------------------ */

async function callLLM(prompt, provider, model, apiKey) {
  const apiUrl = PROVIDER_ENDPOINTS[provider];
  if (!apiUrl) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  // Build headers
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'chrome-extension://ai-form-filler';
  }

  // Build body
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const errMsg = errData?.error?.message || response.statusText;
    throw new Error(`${provider} API Error: ${response.status} – ${errMsg}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Token tracking
  if (data.usage) {
    tokenStats.input += data.usage.prompt_tokens || 0;
    tokenStats.output += data.usage.completion_tokens || 0;
    console.log(
      `[Token] ${provider}/${model} — In: ${data.usage.prompt_tokens}, Out: ${data.usage.completion_tokens} | Σ In: ${tokenStats.input}, Out: ${tokenStats.output}`
    );
  }

  // Strip markdown code fences that some models wrap around JSON.
  // Handle fences anywhere in the response, not just at position 0.
  const fenceMatch = content.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return content;
}
