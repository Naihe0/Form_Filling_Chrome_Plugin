/**
 * Transport to OpenAI-compatible chat endpoints.
 *
 * - Always streams. Chrome may kill a service worker whose fetch has no response
 *   after 30 seconds, and a thinking model easily exceeds that (measured: 55 s
 *   for gemini-3.8-flash at default effort). Streaming gets bytes flowing early.
 * - Retries transient failures with backoff, honouring Retry-After.
 * - Learns what each model rejects. Users can type any model id, and models
 *   differ on temperature, reasoning effort and schema support, so a 400 naming
 *   one of those parameters drops it and retries rather than failing the run.
 */
import { LlmError, RunStopped, type LlmErrorCode } from '../shared/errors.ts';
import type { ProviderSpec, ResponseFormat } from '../shared/providers.ts';
import { emptyUsage, type Usage } from '../shared/types.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface ChatRequest {
  provider: ProviderSpec;
  model: string;
  apiKey: string;
  messages: ChatMessage[];
  schema?: JsonSchemaSpec;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  usage: Usage;
}

export interface GatewayDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TRANSIENT_RETRIES = 3;
const MAX_BACKOFF_MS = 20_000;
const TEMPERATURE = 0.1;

/** Optional request parameters that may be dropped when a model rejects them. */
const OPTIONAL_PARAMS = ['response_format', 'reasoning_effort', 'reasoning', 'temperature', 'stream_options'];

interface Capabilities {
  format: ResponseFormat;
  dropped: Set<string>;
}

const learned = new Map<string, Capabilities>();

export function forgetLearnedCapabilities(): void {
  learned.clear();
}

function capabilitiesFor(provider: ProviderSpec, model: string): Capabilities {
  const key = `${provider.id}:${model}`;
  let capabilities = learned.get(key);
  if (!capabilities) {
    capabilities = { format: provider.format, dropped: new Set() };
    learned.set(key, capabilities);
  }
  return capabilities;
}

/** Records that a parameter was rejected. False if there is nothing left to drop. */
function downgrade(capabilities: Capabilities, param: string): boolean {
  if (param === 'response_format') {
    if (capabilities.format === 'none') return false;
    capabilities.format = capabilities.format === 'json_schema' ? 'json_object' : 'none';
    return true;
  }
  if (capabilities.dropped.has(param)) return false;
  capabilities.dropped.add(param);
  return true;
}

function buildBody(request: ChatRequest, capabilities: Capabilities): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: TEMPERATURE,
    ...request.provider.params,
  };

  if (request.schema && capabilities.format === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema },
    };
  } else if (request.schema && capabilities.format === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  for (const param of capabilities.dropped) delete body[param];
  return body;
}

function codeForStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 404) return 'model_not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Gemini wraps error bodies in an array; everyone else returns an object. */
function parseErrorBody(text: string): { message: string; param?: string } {
  try {
    const parsed = JSON.parse(text);
    const error = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    if (typeof error === 'string') return { message: error };
    if (error?.message) return { message: String(error.message), param: error.param ?? undefined };
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return { message: text.slice(0, 300) };
}

async function errorFromResponse(response: Response, apiKey: string): Promise<LlmError> {
  const { message, param } = parseErrorBody(await response.text().catch(() => ''));
  const retryAfter = Number(response.headers.get('retry-after')) || undefined;
  const clean = (message || response.statusText).replaceAll(apiKey, '[redacted]');
  return new LlmError(codeForStatus(response.status), `HTTP ${response.status}: ${clean}`, {
    retryAfter,
    param,
  });
}

function rejectedParam(error: LlmError): string | undefined {
  if (error.code !== 'bad_request') return undefined;
  return OPTIONAL_PARAMS.find(
    (param) => error.param === param || error.message.includes(param)
  );
}

function usageFrom(raw: any): Usage | null {
  if (!raw) return null;
  const promptTokens = raw.prompt_tokens ?? 0;
  const completionTokens = raw.completion_tokens ?? 0;
  return {
    calls: 1,
    promptTokens,
    completionTokens,
    totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
  };
}

function checkFinish(reason: unknown): void {
  if (reason === 'content_filter' || reason === 'safety' || reason === 'SAFETY') {
    throw new LlmError('refused', 'The model refused to answer (content filter).');
  }
  if (reason === 'length') {
    throw new LlmError('bad_response', 'The reply was cut off at the token limit.');
  }
}

async function readEventStream(body: ReadableStream<Uint8Array>): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: Usage | null = null;

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;

    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // Tolerate keep-alive noise some proxies inject.
    }
    if (chunk.error) {
      const message = chunk.error.message ?? JSON.stringify(chunk.error);
      throw new LlmError('server', `Stream error: ${message}`);
    }
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
    checkFinish(choice?.finish_reason);
    usage = usageFrom(chunk.usage) ?? usage;
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    lines.forEach(handleLine);
    if (done) break;
  }
  if (buffer) handleLine(buffer);

  return { text, usage: usage ?? { ...emptyUsage(), calls: 1 } };
}

async function readJson(response: Response): Promise<ChatResult> {
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new LlmError('bad_response', 'The provider returned an unreadable body.');
  }
  const choice = data.choices?.[0];
  checkFinish(choice?.finish_reason);
  return {
    text: choice?.message?.content ?? '',
    usage: usageFrom(data.usage) ?? { ...emptyUsage(), calls: 1 },
  };
}

async function attempt(
  request: ChatRequest,
  capabilities: Capabilities,
  deps: GatewayDeps
): Promise<ChatResult> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  try {
    const response = await deps.fetch(request.provider.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
        ...request.provider.headers,
      },
      body: JSON.stringify(buildBody(request, capabilities)),
      signal,
    });
    if (!response.ok) throw await errorFromResponse(response, request.apiKey);

    const isStream = response.headers.get('content-type')?.includes('text/event-stream');
    const result =
      isStream && response.body ? await readEventStream(response.body) : await readJson(response);

    if (!result.text.trim()) {
      throw new LlmError('bad_response', 'The model returned an empty reply.');
    }
    return result;
  } catch (cause) {
    if (cause instanceof LlmError) throw cause;
    if (request.signal?.aborted) throw new RunStopped();
    if (timeout.aborted) throw new LlmError('timeout', 'The model did not answer in time.');
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new LlmError('network', `Network error: ${message.replaceAll(request.apiKey, '[redacted]')}`);
  }
}

const defaultDeps: GatewayDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RunStopped());
      const onAbort = () => {
        clearTimeout(timer);
        reject(new RunStopped());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export async function chatCompletion(
  request: ChatRequest,
  deps: GatewayDeps = defaultDeps
): Promise<ChatResult> {
  if (!request.apiKey) {
    throw new LlmError('not_configured', 'No API key is configured for this provider.');
  }

  const capabilities = capabilitiesFor(request.provider, request.model);
  let transientRetries = 0;

  for (;;) {
    try {
      return await attempt(request, capabilities, deps);
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;

      // Not counted as a retry: each downgrade strictly removes a parameter.
      const param = rejectedParam(error);
      if (param && downgrade(capabilities, param)) continue;

      if (!error.retryable || transientRetries >= MAX_TRANSIENT_RETRIES) throw error;
      const backoff = error.retryAfter
        ? error.retryAfter * 1000
        : 1000 * 2 ** transientRetries * (0.75 + Math.random() * 0.5);
      transientRetries++;
      await deps.sleep(Math.min(backoff, MAX_BACKOFF_MS), request.signal);
    }
  }
}
