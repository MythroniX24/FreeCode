/**
 * OpenAI-compatible adapter tests.
 *
 * These run against a real local HTTP server so the transport, the SSE framing
 * and the wire mapping are all exercised together — a stubbed `fetch` would only
 * prove the adapter calls its stub.
 *
 * The two properties worth the most attention here are the ones the whole project
 * turns on:
 *
 *   - **Nothing is fabricated.** No usage when the provider reports none, no stop
 *     reason guessed from a missing field, no model list invented when the
 *     endpoint cannot enumerate.
 *   - **A credential never reaches a URL, a log line or an error message**, even
 *     when the provider echoes the request back in its own error body.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ProviderError, ProviderRateLimitError } from '../src/errors.js';
import { providerConfigSchema, withDefaults, type FreecodeConfig } from '../src/config/schema.js';
import { HttpClient } from '../src/providers/http.js';
import {
  OpenAiCompatibleProvider,
  textOf,
  toStopReason,
  toToolCalls,
  toUsage,
  toWireMessage,
} from '../src/providers/openai-compatible.js';
import { clearRegisteredSecrets, registerSecret } from '../src/util/redact.js';
import type { ProviderContext, ProviderInfo } from '../src/providers/types.js';
import {
  chatChunk,
  chatCompletion,
  json,
  sse,
  sseData,
  startTestServer,
  type TestServer,
} from './helpers/server.js';

const INFO: ProviderInfo = {
  id: 'test',
  name: 'Test Provider',
  defaultBaseUrl: 'http://127.0.0.1:1',
  apiKeyEnvVars: ['TEST_API_KEY'],
  requiresApiKey: true,
};

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  clearRegisteredSecrets();
});

/** Build a context pointed at a test server. */
function makeContext(url: string, overrides: Partial<ProviderContext> = {}): ProviderContext {
  const appConfig: FreecodeConfig = withDefaults({});
  const config = providerConfigSchema.parse({});
  return {
    config,
    apiKey: 'test-key-abc123',
    baseUrl: url,
    appConfig,
    // A logger that discards everything: the tests assert on returned values and
    // thrown errors, and real log noise would obscure a failure.
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => null as never } as never,
    ...overrides,
  };
}

function makeProvider(
  url: string,
  context: Partial<ProviderContext> = {},
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider(makeContext(url, context), { info: INFO });
}

async function server(handler: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const instance = await startTestServer(handler);
  servers.push(instance);
  return instance;
}

// ─────────────────────────────────────────────────────────────────────────────
// listModels
// ─────────────────────────────────────────────────────────────────────────────

describe('listModels', () => {
  it('returns what the endpoint reports', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, { data: [{ id: 'llama-3.3-70b' }, { id: 'mixtral-8x7b' }] }),
    );
    const models = await makeProvider(srv.url).listModels();
    expect(models.map((m) => m.id)).toEqual(['llama-3.3-70b', 'mixtral-8x7b']);
    expect(models[0]?.providerId).toBe('test');
  });

  it('requests the /models path', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: [] }));
    await makeProvider(srv.url).listModels();
    expect(srv.requests[0]?.url).toBe('/models');
  });

  it('accepts a bare array as the response body', async () => {
    // Some self-hosted servers return `[{...}]` rather than `{ data: [...] }`.
    const srv = await server((_req, res) => json(res, 200, { models: [{ id: 'a' }] }));
    expect((await makeProvider(srv.url).listModels()).map((m) => m.id)).toEqual(['a']);
  });

  it('returns an empty list when the endpoint cannot enumerate', async () => {
    // The honest outcome for a server with no catalogue. Inventing a model list
    // here is exactly the fabrication this project forbids.
    const srv = await server((_req, res) => json(res, 200, { unexpected: true }));
    expect(await makeProvider(srv.url).listModels()).toEqual([]);
  });

  it('de-duplicates and drops entries with no usable id', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, { data: [{ id: 'a' }, { id: 'a' }, { notAnId: 1 }, { id: '' }, { id: 'b' }] }),
    );
    expect((await makeProvider(srv.url).listModels()).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('reads the context window from either documented location', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        data: [
          { id: 'a', context_length: 8192 },
          { id: 'b', top_provider: { context_length: 128000 } },
        ],
      }),
    );
    const models = await makeProvider(srv.url).listModels();
    expect(models.find((m) => m.id === 'a')?.contextWindow).toBe(8192);
    expect(models.find((m) => m.id === 'b')?.contextWindow).toBe(128000);
  });

  it('does not invent a context window when the provider states none', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: [{ id: 'llama-3.3-70b' }] }));
    const [model] = await makeProvider(srv.url).listModels();
    expect(model).not.toHaveProperty('contextWindow');
  });

  it('sends the API key in a header, never in the URL', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: [] }));
    await makeProvider(srv.url).listModels();
    const request = srv.requests[0]!;
    expect(request.headers['authorization']).toBe('Bearer test-key-abc123');
    expect(request.url).not.toContain('test-key');
  });

  it('omits the Authorization header when no key is configured', async () => {
    // Ollama and llama.cpp need no credential; sending an empty Bearer would be
    // rejected by some servers and is simply wrong.
    const srv = await server((_req, res) => json(res, 200, { data: [] }));
    await makeProvider(srv.url, { apiKey: undefined }).listModels();
    expect(srv.requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('applies configured extra headers', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: [] }));
    const context = makeContext(srv.url);
    const provider = new OpenAiCompatibleProvider(
      { ...context, config: { ...context.config, headers: { 'x-org': 'acme' } } },
      { info: INFO },
    );
    await provider.listModels();
    expect(srv.requests[0]?.headers['x-org']).toBe('acme');
  });

  it('normalises a trailing slash on the base URL', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: [] }));
    await makeProvider(`${srv.url}/`).listModels();
    expect(srv.requests[0]?.url).toBe('/models');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chat
// ─────────────────────────────────────────────────────────────────────────────

describe('chat', () => {
  it('returns the assistant text', async () => {
    const srv = await server((_req, res) => json(res, 200, chatCompletion({ content: 'hello' })));
    const response = await makeProvider(srv.url).chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    expect(response.content).toBe('hello');
    expect(response.stopReason).toBe('end_turn');
  });

  it('posts to the chat-completions path with the model and messages', async () => {
    const srv = await server((_req, res) => json(res, 200, chatCompletion({ content: 'x' })));
    await makeProvider(srv.url).chat({
      model: 'my-model',
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
    });
    const body = JSON.parse(srv.requests[0]!.body) as Record<string, unknown>;
    expect(srv.requests[0]?.url).toBe('/chat/completions');
    expect(body['model']).toBe('my-model');
    expect(body['stream']).toBe(false);
    expect(body['messages']).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it('reports usage when the provider supplies it', async () => {
    const srv = await server((_req, res) =>
      json(
        res,
        200,
        chatCompletion({ content: 'x', usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      ),
    );
    const response = await makeProvider(srv.url).chat({
      model: 'm',
      messages: [],
      stream: false,
    });
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it('leaves usage undefined when the provider reports none', async () => {
    // Recording zero here would corrupt a quota ledger; "unknown" is the truth.
    const srv = await server((_req, res) => json(res, 200, chatCompletion({ content: 'x' })));
    const response = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(response.usage).toBeUndefined();
  });

  it('treats a partial usage report as unknown rather than guessing', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, chatCompletion({ content: 'x', usage: { total_tokens: 14 } })),
    );
    const response = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(response.usage).toBeUndefined();
  });

  it('parses tool calls with arguments left as a raw JSON string', async () => {
    const srv = await server((_req, res) =>
      json(
        res,
        200,
        chatCompletion({
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
            },
          ],
          finishReason: 'tool_calls',
        }),
      ),
    );
    const response = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' },
    ]);
    expect(response.stopReason).toBe('tool_use');
  });

  it('does not treat an unrecognised finish_reason as success', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, chatCompletion({ content: 'x', finishReason: 'brand_new_reason' })),
    );
    const response = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(response.stopReason).toBe('unknown');
  });

  it('retries a 500 and succeeds on the second attempt', async () => {
    let calls = 0;
    const srv = await server((_req, res) => {
      calls += 1;
      if (calls === 1) return json(res, 500, { error: { message: 'upstream hiccup' } });
      return json(res, 200, chatCompletion({ content: 'recovered' }));
    });
    const response = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(response.content).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const srv = await server((_req, res) => {
      calls += 1;
      json(res, 400, { error: { message: 'bad request' } });
    });
    await expect(
      makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false }),
    ).rejects.toThrow(/bad request/);
    expect(calls).toBe(1);
  });

  it('surfaces a 401 as a non-retryable auth failure', async () => {
    const srv = await server((_req, res) => json(res, 401, { error: { message: 'invalid key' } }));
    const error = await makeProvider(srv.url)
      .chat({ model: 'm', messages: [], stream: false })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(401);
    expect((error as ProviderError).retryable).toBe(false);
  });

  it('passes sampling parameters through only when set', async () => {
    const srv = await server((_req, res) => json(res, 200, chatCompletion({ content: 'x' })));
    await makeProvider(srv.url).chat({
      model: 'm',
      messages: [],
      stream: false,
      temperature: 0.7,
      maxTokens: 100,
    });
    const body = JSON.parse(srv.requests[0]!.body) as Record<string, unknown>;
    expect(body['temperature']).toBe(0.7);
    expect(body['max_tokens']).toBe(100);
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('stop');
  });

  it('lets `extra` override a modelled field', async () => {
    const srv = await server((_req, res) => json(res, 200, chatCompletion({ content: 'x' })));
    await makeProvider(srv.url).chat({
      model: 'm',
      messages: [],
      stream: false,
      extra: { reasoning_effort: 'high' },
    });
    const body = JSON.parse(srv.requests[0]!.body) as Record<string, unknown>;
    expect(body['reasoning_effort']).toBe('high');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credential containment
// ─────────────────────────────────────────────────────────────────────────────

describe('credential containment', () => {
  it('does not leak an echoed API key into an error message', async () => {
    // A provider that reflects the request (including the Authorization header)
    // in its error body is the realistic leak path into a log file.
    const secret = 'sk-live-SUPER12';
    registerSecret(secret);

    const srv = await server((_req, res) =>
      json(res, 400, { error: { message: `Bad request. Authorization: Bearer ${secret}` } }),
    );
    const error = await makeProvider(srv.url, { apiKey: secret })
      .chat({ model: 'm', messages: [], stream: false })
      .catch((e: unknown) => e as ProviderError);

    expect((error as ProviderError).message).not.toContain(secret);
    expect((error as ProviderError).message).toContain('[REDACTED]');
  });

  it('does not leak a secret echoed in a non-JSON error body', async () => {
    const secret = 'sk-live-ANOTHER12';
    registerSecret(secret);
    const srv = await server((_req, res) => json(res, 500, `internal error for key ${secret}`));

    const error = await makeProvider(srv.url, { apiKey: secret })
      .chat({ model: 'm', messages: [], stream: false })
      .catch((e: unknown) => e as ProviderError);
    expect((error as ProviderError).message).not.toContain(secret);
  });

  it('refuses a base URL carrying embedded credentials', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: [] }));
    const host = srv.url.replace('http://', '');
    const error = await makeProvider(`http://user:pass@${host}`)
      .listModels()
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).toMatch(/credentials/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('reports Retry-After from a 429', async () => {
    // The server always 429s, so the retries are exhausted and the final error is
    // the one surfaced — which is the object carrying the parsed header.
    const srv = await server((_req, res) =>
      json(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '0' }),
    );
    const error = await makeProvider(srv.url)
      .chat({ model: 'm', messages: [], stream: false })
      .catch((e: unknown) => e as ProviderRateLimitError);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect((error as ProviderRateLimitError).retryAfterSeconds).toBe(0);
  });

  it('caps an absurd Retry-After rather than waiting indefinitely', async () => {
    // A provider asking for a week is more likely misconfigured than sincere; the
    // caller should see a bounded wait instead of an apparent hang.
    const srv = await server((_req, res) => json(res, 429, {}, { 'retry-after': '604800' }));
    const error = await makeProvider(srv.url)
      .chat({ model: 'm', messages: [], stream: false })
      .catch((e: unknown) => e as ProviderRateLimitError);

    expect((error as ProviderRateLimitError).retryAfterSeconds).toBe(3600);
  });

  it('parses an HTTP-date Retry-After', async () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const srv = await server((_req, res) => json(res, 429, {}, { 'retry-after': future }));
    const error = await makeProvider(srv.url)
      .chat({ model: 'm', messages: [], stream: false })
      .catch((e: unknown) => e as ProviderRateLimitError);

    expect((error as ProviderRateLimitError).retryAfterSeconds).toBeGreaterThan(40);
    expect((error as ProviderRateLimitError).retryAfterSeconds).toBeLessThanOrEqual(46);
  });

  it('waits the interval the provider asked for before retrying', async () => {
    // The delay is real, so it is kept small: `Retry-After: 1` plus a second
    // successful attempt. What matters is that the wait happens at all — an
    // immediate retry against a free tier is how an account gets flagged.
    let calls = 0;
    const srv = await server((_req, res) => {
      calls += 1;
      if (calls === 1) {
        return json(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '1' });
      }
      return json(res, 200, chatCompletion({ content: 'recovered' }));
    });

    const started = Date.now();
    const response = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    const elapsed = Date.now() - started;

    expect(response.content).toBe('recovered');
    expect(calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(4_000);
  });

  it('gives up after the attempt budget on a persistent 429', async () => {
    let calls = 0;
    const srv = await server((_req, res) => {
      calls += 1;
      json(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '0' });
    });
    const error = await makeProvider(srv.url)
      .chat({ model: 'm', messages: [], stream: false })
      .catch((e: unknown) => e as ProviderRateLimitError);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(calls).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Streaming
// ─────────────────────────────────────────────────────────────────────────────

describe('stream', () => {
  /** Collect every event from a stream into an array. */
  async function collect(
    provider: OpenAiCompatibleProvider,
    model = 'test-model',
  ): Promise<Array<{ type: string; [key: string]: unknown }>> {
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of provider.stream({ model, messages: [], stream: true })) {
      events.push(event as unknown as { type: string; [key: string]: unknown });
    }
    return events;
  }

  it('yields start, text deltas and a done event', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData(chatChunk({ role: 'assistant', content: 'He' })),
        sseData(chatChunk({ content: 'llo' })),
        sseData(chatChunk({}, 'stop')),
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(makeProvider(srv.url));
    expect(events[0]?.type).toBe('start');
    expect(events.filter((e) => e.type === 'text').map((e) => e['delta'])).toEqual(['He', 'llo']);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  it('sets stream: true and requests usage in stream options', async () => {
    const srv = await server((_req, res) => sse(res, ['data: [DONE]\n\n']));
    await collect(makeProvider(srv.url)).catch(() => undefined);
    const body = JSON.parse(srv.requests[0]!.body) as Record<string, unknown>;
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
  });

  it('handles a chunk split across TCP segments', async () => {
    // The realistic case: proxies and servers split wherever the buffer fills.
    const payload = sseData(chatChunk({ content: 'split' }));
    const half = Math.floor(payload.length / 2);
    const srv = await server((_req, res) =>
      sse(res, [payload.slice(0, half), payload.slice(half), 'data: [DONE]\n\n']),
    );

    const events = await collect(makeProvider(srv.url));
    expect(events.filter((e) => e.type === 'text').map((e) => e['delta'])).toEqual(['split']);
  });

  it('survives a multi-byte character split across segments', async () => {
    const payload = sseData(chatChunk({ content: 'café 🎉' }));
    const bytes = Buffer.from(payload, 'utf8');
    const cut = bytes.indexOf(0xc3) + 1; // inside the é

    const srv = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(bytes.subarray(0, cut));
      res.write(bytes.subarray(cut));
      res.end('data: [DONE]\n\n');
    });

    const events = await collect(makeProvider(srv.url));
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e['delta'])
      .join('');
    expect(text).toBe('café 🎉');
    expect(text).not.toContain('�');
  });

  it('ignores keepalive comments', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        ': ping\n\n',
        sseData(chatChunk({ content: 'ok' })),
        ': ping\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const events = await collect(makeProvider(srv.url));
    expect(events.filter((e) => e.type === 'text').map((e) => e['delta'])).toEqual(['ok']);
  });

  it('accumulates fragmented tool-call arguments into one call', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData(
          chatChunk({
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } },
            ],
          }),
        ),
        sseData(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] })),
        sseData(chatChunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] })),
        sseData(chatChunk({}, 'tool_calls')),
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(makeProvider(srv.url));
    const starts = events.filter((e) => e.type === 'tool_call_start');
    const ends = events.filter((e) => e.type === 'tool_call_end');

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ index: 0, id: 'call_1', name: 'read_file' });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ index: 0, argumentsJson: '{"path":"a.ts"}' });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' });
  });

  it('tracks parallel tool calls by index', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData(
          chatChunk({
            tool_calls: [{ index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } }],
          }),
        ),
        sseData(
          chatChunk({
            tool_calls: [{ index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } }],
          }),
        ),
        sseData(chatChunk({}, 'tool_calls')),
        'data: [DONE]\n\n',
      ]),
    );

    const ends = (await collect(makeProvider(srv.url))).filter((e) => e.type === 'tool_call_end');
    expect(ends.map((e) => e['index'])).toEqual([0, 1]);
  });

  it('infers tool_use when tool calls arrive with no finish_reason', async () => {
    // Reporting `end_turn` here would make the agent loop stop before running
    // the tools the model just asked for.
    const srv = await server((_req, res) =>
      sse(res, [
        sseData(
          chatChunk({
            tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{}' } }],
          }),
        ),
        'data: [DONE]\n\n',
      ]),
    );
    expect((await collect(makeProvider(srv.url))).at(-1)).toMatchObject({
      type: 'done',
      stopReason: 'tool_use',
    });
  });

  it('reports reasoning deltas separately from answer text', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData(chatChunk({ reasoning_content: 'thinking...' })),
        sseData(chatChunk({ content: 'answer' })),
        sseData(chatChunk({}, 'stop')),
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(makeProvider(srv.url));
    expect(events.filter((e) => e.type === 'reasoning').map((e) => e['delta'])).toEqual([
      'thinking...',
    ]);
    expect(events.filter((e) => e.type === 'text').map((e) => e['delta'])).toEqual(['answer']);
  });

  it('emits a usage event when the stream reports one', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData(chatChunk({ content: 'x' })),
        sseData({ ...chatChunk({}, 'stop'), usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(makeProvider(srv.url));
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });

  it('does not emit usage when the stream reports none', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData(chatChunk({ content: 'x' })),
        sseData(chatChunk({}, 'stop')),
        'data: [DONE]\n\n',
      ]),
    );
    expect((await collect(makeProvider(srv.url))).some((e) => e.type === 'usage')).toBe(false);
  });

  it('skips an unparseable chunk without losing the rest', async () => {
    // A truncated keepalive-shaped payload must not abort a half-delivered answer.
    const srv = await server((_req, res) =>
      sse(res, [
        sseData(chatChunk({ content: 'before' })),
        'data: {"broken":\n\n',
        sseData(chatChunk({ content: 'after' })),
        'data: [DONE]\n\n',
      ]),
    );

    const text = (await collect(makeProvider(srv.url)))
      .filter((e) => e.type === 'text')
      .map((e) => e['delta'])
      .join('');
    expect(text).toBe('beforeafter');
  });

  it('throws a clear error when the endpoint answers with JSON', async () => {
    const srv = await server((_req, res) => json(res, 200, { error: 'not a stream' }));
    await expect(collect(makeProvider(srv.url))).rejects.toThrow(/SSE stream was expected/);
  });

  it('throws when the stream is completely empty', async () => {
    const srv = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
    });
    await expect(collect(makeProvider(srv.url))).rejects.toThrow(/empty stream/);
  });

  it('surfaces an in-band error status', async () => {
    const srv = await server((_req, res) =>
      json(res, 503, { error: { message: 'model loading' } }, { 'retry-after': '0' }),
    );
    await expect(collect(makeProvider(srv.url))).rejects.toThrow(/model loading/);
  });

  it('stops promptly when the caller aborts', async () => {
    // The server holds the connection open after the first token, so the only
    // thing that can end the loop is the abort. A fixed sleep here would be
    // flaky; the test waits for the event it is about to interrupt.
    const srv = await server(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseData(chatChunk({ content: 'first' })));
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      res.end();
    });

    const controller = new AbortController();
    const provider = makeProvider(srv.url);
    const seen: string[] = [];
    let sawFirst: () => void = () => undefined;
    const firstArrived = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });

    const iterate = (async () => {
      for await (const event of provider.stream({
        model: 'test-model',
        messages: [],
        stream: true,
        signal: controller.signal,
      })) {
        if (event.type === 'text') {
          seen.push(event.delta);
          sawFirst();
        }
      }
    })();

    await firstArrived;
    const abortedAt = Date.now();
    controller.abort(new Error('user cancelled'));

    await expect(iterate).rejects.toThrow();
    expect(seen).toEqual(['first']);
    // "Promptly" is the property under test: the loop must not run until the
    // server's 5s hold expires.
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkHealth
// ─────────────────────────────────────────────────────────────────────────────

describe('checkHealth', () => {
  it('reports healthy when the endpoint lists models', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: [{ id: 'a' }] }));
    const health = await makeProvider(srv.url).checkHealth();
    expect(health.healthy).toBe(true);
    expect(health.consecutiveFailures).toBe(0);
  });

  it('probes with a one-token completion when the endpoint cannot enumerate', async () => {
    // Capped at one token so the check cannot cost meaningfully on a metered key.
    const srv = await server((req, res) => {
      if (req.url === '/models') return json(res, 404, { error: 'no catalogue' });
      return json(res, 200, chatCompletion({ content: '.' }));
    });

    const provider = new OpenAiCompatibleProvider(
      {
        ...makeContext(srv.url),
        config: providerConfigSchema.parse({ models: ['tiny-model'] }),
      },
      { info: INFO },
    );
    const health = await provider.checkHealth();
    expect(health.healthy).toBe(true);

    const chatRequest = srv.requests.find((r) => r.url === '/chat/completions');
    expect(chatRequest).toBeDefined();
    expect(JSON.parse(chatRequest!.body)['max_tokens']).toBe(1);
  });

  it('reports unhealthy with a reason when the endpoint is unreachable', async () => {
    // Port 1 on loopback is permitted by the guard but nothing listens there.
    const provider = makeProvider('http://127.0.0.1:1');
    const health = await provider.checkHealth();
    expect(health.healthy).toBe(false);
    expect(health.lastError).toBeTruthy();
  });

  it('counts consecutive failures', async () => {
    const provider = makeProvider('http://127.0.0.1:1');
    await provider.checkHealth();
    const second = await provider.checkHealth();
    expect(second.consecutiveFailures).toBe(2);
  });

  it('does not probe when no model is configured', async () => {
    // With no catalogue and no configured model there is nothing honest to try;
    // the check reports the configuration gap rather than inventing a model id.
    const srv = await server((_req, res) => json(res, 404, { error: 'no catalogue' }));
    const health = await makeProvider(srv.url).checkHealth();
    expect(health.healthy).toBe(false);
    expect(health.lastError).toMatch(/no model is configured/i);
    expect(srv.requests.every((r) => r.url !== '/chat/completions')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire-mapping unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('toWireMessage', () => {
  it('maps a user message', () => {
    expect(toWireMessage({ role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' });
  });

  it('maps a tool result', () => {
    expect(toWireMessage({ role: 'tool', toolCallId: 'call_1', content: 'out' })).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'out',
    });
  });

  it('maps an assistant turn that carries tool calls', () => {
    const wire = toWireMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
    });
    expect(wire['tool_calls']).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
    ]);
  });

  it('substitutes {} for empty tool arguments', () => {
    // Some servers reject an empty string where a JSON object is required.
    const wire = toWireMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'list_files', argumentsJson: '' }],
    });
    expect(
      (wire['tool_calls'] as { function: { arguments: string } }[])[0]!.function.arguments,
    ).toBe('{}');
  });

  it('passes argument bytes through unchanged', () => {
    // Re-serializing a parsed object reorders keys and breaks prompt caching on
    // servers that hash the request.
    const original = '{"z":1,"a":2,"m":{"nested":true}}';
    const wire = toWireMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 't', argumentsJson: original }],
    });
    expect(
      (wire['tool_calls'] as { function: { arguments: string } }[])[0]!.function.arguments,
    ).toBe(original);
  });

  it('maps image blocks to a data URL', () => {
    const wire = toWireMessage({
      role: 'user',
      content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }],
    });
    expect(wire['content']).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
});

describe('textOf', () => {
  it('passes a string through', () => {
    expect(textOf('hi')).toBe('hi');
  });

  it('joins text parts of an array', () => {
    expect(
      textOf([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('returns empty for null and undefined', () => {
    expect(textOf(null)).toBe('');
    expect(textOf(undefined)).toBe('');
  });
});

describe('toUsage', () => {
  it('requires both halves', () => {
    expect(toUsage({ prompt_tokens: 5 })).toBeUndefined();
    expect(toUsage({ completion_tokens: 5 })).toBeUndefined();
    expect(toUsage({ prompt_tokens: 5, completion_tokens: 2 })).toEqual({
      inputTokens: 5,
      outputTokens: 2,
    });
  });

  it('carries cached and reasoning token counts when reported', () => {
    const usage = toUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 15 },
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 80,
      reasoningTokens: 15,
    });
  });

  it('returns undefined for a null usage object', () => {
    expect(toUsage(null)).toBeUndefined();
  });
});

describe('toStopReason', () => {
  it('maps the documented reasons', () => {
    expect(toStopReason('stop')).toBe('end_turn');
    expect(toStopReason('length')).toBe('max_tokens');
    expect(toStopReason('tool_calls')).toBe('tool_use');
    expect(toStopReason('content_filter')).toBe('content_filter');
  });

  it('maps an unrecognised value to unknown, not to success', () => {
    expect(toStopReason('something_new')).toBe('unknown');
    expect(toStopReason(null)).toBe('unknown');
    expect(toStopReason(undefined)).toBe('unknown');
  });
});

describe('toToolCalls', () => {
  it('supplies a positional id when the server omits one', () => {
    // The id is echoed back with the result; a missing one breaks the pairing
    // the next request depends on.
    const calls = toToolCalls([{ function: { name: 'read_file', arguments: '{}' } }]);
    expect(calls[0]?.id).toBe('call_0');
  });

  it('serialises object-shaped arguments', () => {
    const calls = toToolCalls([{ id: 'c', function: { name: 't', arguments: { path: 'a.ts' } } }]);
    expect(calls[0]?.argumentsJson).toBe('{"path":"a.ts"}');
  });

  it('drops an entry with no function name', () => {
    expect(toToolCalls([{ id: 'c', function: {} }])).toEqual([]);
  });

  it('defaults missing arguments to an empty object', () => {
    expect(toToolCalls([{ id: 'c', function: { name: 't' } }])[0]?.argumentsJson).toBe('{}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transport-level behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('response size cap', () => {
  it('refuses a body above the configured limit', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: 'x'.repeat(5_000) }));
    const provider = new OpenAiCompatibleProvider(makeContext(srv.url), {
      info: INFO,
      http: new HttpClient({ maxResponseBytes: 1_000 }),
    });
    await expect(provider.listModels()).rejects.toThrow(/exceeded the 1000-byte limit/);
  });
});
