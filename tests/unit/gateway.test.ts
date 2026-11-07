import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  chatCompletion,
  forgetLearnedCapabilities,
  type ChatRequest,
  type GatewayDeps,
} from '../../src/llm/gateway.ts';
import { LlmError, RunStopped } from '../../src/shared/errors.ts';
import { PROVIDERS } from '../../src/shared/providers.ts';

const KEY = 'test-key-123';

function sse(...chunks: unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const delta = (content: string) => ({ choices: [{ delta: { content } }] });

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A fetch that replays canned responses and records every request. */
function fakeDeps(...replies: Array<Response | Error>) {
  const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
  const sleeps: number[] = [];
  const deps: GatewayDeps = {
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(String(init.body)) });
      const reply = replies.shift();
      if (!reply) throw new Error('fetch called more often than scripted');
      if (reply instanceof Error) throw reply;
      return reply;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, requests, sleeps };
}

const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: PROVIDERS.gemini,
  model: 'gemini-flash-latest',
  apiKey: KEY,
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

const schema = { name: 's', schema: { type: 'object' } };

beforeEach(() => forgetLearnedCapabilities());

describe('chatCompletion: reading replies', () => {
  it('assembles a streamed reply and reports usage including thinking tokens', async () => {
    const { deps } = fakeDeps(
      sse(delta('{"a"'), delta(':1}'), {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 144 },
      })
    );
    const result = await chatCompletion(request(), deps);
    assert.equal(result.text, '{"a":1}');
    assert.deepEqual(result.usage, { calls: 1, promptTokens: 12, completionTokens: 6, totalTokens: 144 });
  });

  it('handles chunks split mid-line', async () => {
    const encoder = new TextEncoder();
    const payload = `data: ${JSON.stringify(delta('hello'))}\n\ndata: [DONE]\n\n`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 15)));
        controller.enqueue(encoder.encode(payload.slice(15)));
        controller.close();
      },
    });
    const { deps } = fakeDeps(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    assert.equal((await chatCompletion(request(), deps)).text, 'hello');
  });

  it('accepts a plain JSON reply from a proxy that ignores stream', async () => {
    const { deps } = fakeDeps(
      new Response(JSON.stringify({ choices: [{ message: { content: 'plain' } }] }), {
        headers: { 'content-type': 'application/json' },
      })
    );
    assert.equal((await chatCompletion(request(), deps)).text, 'plain');
  });

  it('sends the key as a bearer token and asks for low thinking on Gemini', async () => {
    const { deps, requests } = fakeDeps(sse(delta('ok')));
    await chatCompletion(request({ schema }), deps);
    const { init, body } = requests[0];
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    assert.equal(body.stream, true);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
  });

  it('treats an empty reply as retryable', async () => {
    const { deps, requests } = fakeDeps(sse(delta('  ')), sse(delta('ok')));
    assert.equal((await chatCompletion(request(), deps)).text, 'ok');
    assert.equal(requests.length, 2);
  });

  it('reports a content filter as a refusal without retrying', async () => {
    const { deps, requests } = fakeDeps(sse({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }));
    await assert.rejects(chatCompletion(request(), deps), (e: LlmError) => e.code === 'refused');
    assert.equal(requests.length, 1);
  });

  it('surfaces an error delivered inside the stream', async () => {
    const { deps } = fakeDeps(
      sse({ error: { message: 'boom' } }),
      sse({ error: { message: 'boom' } }),
      sse({ error: { message: 'boom' } }),
      sse({ error: { message: 'boom' } })
    );
    await assert.rejects(chatCompletion(request(), deps), /boom/);
  });
});

describe('chatCompletion: retries', () => {
  it('retries a 503 with backoff, then succeeds', async () => {
    const { deps, sleeps } = fakeDeps(errorResponse(503, { error: { message: 'busy' } }), sse(delta('ok')));
    assert.equal((await chatCompletion(request(), deps)).text, 'ok');
    assert.equal(sleeps.length, 1);
  });

  it('honours Retry-After on a 429', async () => {
    const { deps, sleeps } = fakeDeps(
      errorResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }),
      sse(delta('ok'))
    );
    await chatCompletion(request(), deps);
    assert.deepEqual(sleeps, [7000]);
  });

  it('retries network errors and gives up after a bound', async () => {
    const { deps, requests } = fakeDeps(
      new TypeError('net down'),
      new TypeError('net down'),
      new TypeError('net down'),
      new TypeError('net down')
    );
    await assert.rejects(chatCompletion(request(), deps), (e: LlmError) => e.code === 'network');
    assert.equal(requests.length, 4);
  });

  it('does not retry an authentication failure', async () => {
    const { deps, requests } = fakeDeps(errorResponse(401, { error: { message: 'bad key' } }));
    await assert.rejects(chatCompletion(request(), deps), (e: LlmError) => e.code === 'auth');
    assert.equal(requests.length, 1);
  });

  it('parses Gemini array-wrapped errors and keeps its advice', async () => {
    const body = [{ error: { code: 404, message: 'gemini-2.5-flash is no longer available; use gemini-3.8-flash' } }];
    const { deps, requests } = fakeDeps(errorResponse(404, body));
    await assert.rejects(
      chatCompletion(request(), deps),
      (e: LlmError) => e.code === 'model_not_found' && e.message.includes('gemini-3.8-flash')
    );
    assert.equal(requests.length, 1);
  });

  it('never leaks the key through an error message', async () => {
    const { deps } = fakeDeps(errorResponse(401, { error: { message: `Bad key ${KEY}` } }));
    await assert.rejects(chatCompletion(request(), deps), (e: LlmError) => {
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  });

  it('fails fast with no key configured', async () => {
    const { deps, requests } = fakeDeps();
    await assert.rejects(chatCompletion(request({ apiKey: '' }), deps), (e: LlmError) => e.code === 'not_configured');
    assert.equal(requests.length, 0);
  });
});

describe('chatCompletion: learning what a model rejects', () => {
  it('drops a parameter the model rejects, and remembers', async () => {
    const { deps, requests } = fakeDeps(
      errorResponse(400, { error: { message: "Unsupported parameter: 'reasoning_effort'", param: 'reasoning_effort' } }),
      sse(delta('one')),
      sse(delta('two'))
    );

    assert.equal((await chatCompletion(request({ provider: PROVIDERS.openai, model: 'gpt-4.1' }), deps)).text, 'one');
    assert.equal(requests[0].body.reasoning_effort, 'low');
    assert.equal(requests[1].body.reasoning_effort, undefined);

    await chatCompletion(request({ provider: PROVIDERS.openai, model: 'gpt-4.1' }), deps);
    assert.equal(requests[2].body.reasoning_effort, undefined);
    assert.equal(requests.length, 3);
  });

  it('drops temperature for models that fix it', async () => {
    const { deps, requests } = fakeDeps(
      errorResponse(400, { error: { message: "Unsupported value: 'temperature' does not support 0.1 with this model." } }),
      sse(delta('ok'))
    );
    await chatCompletion(request({ provider: PROVIDERS.openai, model: 'gpt-5.2' }), deps);
    assert.equal(requests[1].body.temperature, undefined);
  });

  it('steps a schema down to json_object, then to nothing', async () => {
    const reject = () => errorResponse(400, { error: { message: 'response_format is not supported' } });
    const { deps, requests } = fakeDeps(reject(), reject(), sse(delta('ok')));

    await chatCompletion(request({ schema }), deps);

    assert.equal(requests[0].body.response_format.type, 'json_schema');
    assert.equal(requests[1].body.response_format.type, 'json_object');
    assert.equal(requests[2].body.response_format, undefined);
  });

  it('keeps what it learned separate per model', async () => {
    const { deps, requests } = fakeDeps(
      errorResponse(400, { error: { message: 'unknown temperature' } }),
      sse(delta('a')),
      sse(delta('b'))
    );
    await chatCompletion(request({ model: 'model-a' }), deps);
    await chatCompletion(request({ model: 'model-b' }), deps);
    assert.equal(requests[2].body.temperature, 0.1);
  });

  it('fails on a 400 it cannot attribute to an optional parameter', async () => {
    const { deps, requests } = fakeDeps(errorResponse(400, { error: { message: 'messages must not be empty' } }));
    await assert.rejects(chatCompletion(request(), deps), (e: LlmError) => e.code === 'bad_request');
    assert.equal(requests.length, 1);
  });

  it('gives up if the provider keeps rejecting a parameter already dropped', async () => {
    const reject = () => errorResponse(400, { error: { message: 'temperature is bad' } });
    const { deps, requests } = fakeDeps(reject(), reject());
    await assert.rejects(chatCompletion(request(), deps), (e: LlmError) => e.code === 'bad_request');
    assert.equal(requests.length, 2);
  });
});

describe('chatCompletion: cancellation', () => {
  it('turns a user abort into RunStopped without retrying', async () => {
    const controller = new AbortController();
    const requests: unknown[] = [];
    const deps: GatewayDeps = {
      fetch: async (_url, init) => {
        requests.push(init);
        controller.abort();
        init.signal?.throwIfAborted();
        return sse(delta('never'));
      },
      sleep: async () => {},
    };
    await assert.rejects(chatCompletion(request({ signal: controller.signal }), deps), RunStopped);
    assert.equal(requests.length, 1);
  });

  it('reports a slow provider as a timeout', async () => {
    const deps: GatewayDeps = {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      sleep: async () => {},
    };
    await assert.rejects(chatCompletion(request({ timeoutMs: 5 }), deps), (e: LlmError) => e.code === 'timeout');
  });
});
