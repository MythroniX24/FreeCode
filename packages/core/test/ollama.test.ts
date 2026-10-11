/**
 * Ollama adapter tests, against a real local HTTP server.
 *
 * Ollama is the loopback exception in the SSRF guard — `localhost:11434` is a
 * user's own daemon, and the tests bind to 127.0.0.1 through the same path. The
 * commitments under test:
 *
 *  - The adapter sends no credential anywhere (Ollama has no auth), and headers
 *    never carry one.
 *  - `listModels` asks `/api/tags` and never fabricates a model id.
 *  - Usage comes only from the terminal `done` record; a stream that never shows
 *    `done` yields `undefined` usage.
 *  - Streaming is newline-framed NDJSON, not SSE — the `data:` prefix that the
 *    OpenAI-family endpoints need must never appear in the framing.
 *  - Tool calls arrive whole, and `done_reason` maps through the closed enum.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { providerConfigSchema, withDefaults, type FreecodeConfig } from '../src/config/schema.js';
import { OllamaProvider, readNdjson, toStopReason, toToolCalls } from '../src/providers/ollama.js';
import { clearRegisteredSecrets } from '../src/util/redact.js';
import type { ProviderContext, ProviderInfo, StreamEvent } from '../src/providers/types.js';
import { json, startTestServer, type TestServer } from './helpers/server.js';

const INFO: ProviderInfo = {
  id: 'ollama',
  name: 'Ollama',
  // No key, no auth story. The daemon binds to the loopback by default.
  defaultBaseUrl: 'http://localhost:11434',
  apiKeyEnvVars: [],
  requiresApiKey: false,
};

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  clearRegisteredSecrets();
});

function makeContext(url: string, overrides: Partial<ProviderContext> = {}): ProviderContext {
  const appConfig: FreecodeConfig = withDefaults({});
  const config = providerConfigSchema.parse({});
  return {
    config,
    apiKey: undefined,
    baseUrl: url,
    appConfig,
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => null as never } as never,
    ...overrides,
  };
}

function makeProvider(url: string): OllamaProvider {
  return new OllamaProvider(makeContext(url), { info: INFO });
}

async function server(handler: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const instance = await startTestServer(handler);
  servers.push(instance);
  return instance;
}

/** Emit an Ollama newline-framed JSON body. */
function ndjson(
  res: Parameters<typeof json>[0],
  status: number,
  lines: readonly Record<string, unknown>[],
): void {
  res.writeHead(status, { 'content-type': 'application/x-ndjson' });
  res.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

// ─────────────────────────────────────────────────────────────────────────────
// listModels
// ─────────────────────────────────────────────────────────────────────────────

describe('listModels', () => {
  it('requests /api/tags and returns the tags without inventing entries', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        models: [
          { name: 'llama3.1:8b', model: 'llama3.1:8b' },
          { name: 'nomic-embed-text:latest' },
        ],
      }),
    );
    const models = await makeProvider(srv.url).listModels();
    expect(srv.requests[0]?.url).toBe('/api/tags');
    expect(models.map((m) => m.id)).toEqual(['llama3.1:8b', 'nomic-embed-text:latest']);
    expect(models.every((m) => m.providerId === 'ollama')).toBe(true);
    // Default base URL means no key header is ever sent.
    expect(srv.requests[0]?.headers['authorization']).toBeUndefined();
    expect(srv.requests[0]?.headers['x-goog-api-key']).toBeUndefined();
  });

  it('returns an empty list when the daemon cannot enumerate', async () => {
    const srv = await server((_req, res) => json(res, 200, { unexpected: true }));
    expect(await makeProvider(srv.url).listModels()).toEqual([]);
  });

  it('marks no model as requiring a key at the info level', () => {
    expect(INFO.requiresApiKey).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chat (non-streaming)
// ─────────────────────────────────────────────────────────────────────────────

describe('chat', () => {
  it('posts to /api/chat and maps a text reply', async () => {
    const srv = await server((req, res) => {
      if (req.url === '/api/chat') {
        return json(res, 200, {
          model: 'llama3.1:8b',
          created_at: '2024-01-01T00:00:00Z',
          message: { role: 'assistant', content: 'Hello.' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 5,
          eval_count: 2,
        });
      }
      return json(res, 404, {});
    });

    const result = await makeProvider(srv.url).chat({
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    const body = JSON.parse(srv.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['model']).toBe('llama3.1:8b');
    expect(body['stream']).toBe(false);
    expect((body['messages'] as Record<string, unknown>[])[0]).toEqual({
      role: 'user',
      content: 'hi',
    });

    expect(result.content).toBe('Hello.');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('maps options like maxTokens into the Ollama options object', async () => {
    const srv = await server((_req, res) => json(res, 200, { done: true, done_reason: 'stop' }));
    await makeProvider(srv.url).chat({
      model: 'm',
      messages: [],
      stream: false,
      maxTokens: 64,
      temperature: 0.5,
    });
    const body = JSON.parse(srv.requests[0]?.body ?? '{}') as Record<string, unknown>;
    const options = (body['options'] ?? {}) as Record<string, unknown>;
    expect(options['num_predict']).toBe(64);
    expect(options['temperature']).toBe(0.5);
  });

  it('maps tool calls with whole arguments', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
        },
        done: true,
        done_reason: 'stop',
      }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([
      { id: 'get_weather', name: 'get_weather', argumentsJson: '{"city":"Paris"}' },
    ]);
  });

  it('does not fabricate usage when the counts are absent', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, { message: { role: 'assistant', content: 'ok' }, done: true }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.usage).toBeUndefined();
  });

  it('maps done_reason length to max_tokens, not end_turn', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        message: { role: 'assistant', content: '...' },
        done: true,
        done_reason: 'length',
      }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.stopReason).toBe('max_tokens');
  });

  it('maps done_reason error to the error stop reason', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'error',
      }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.stopReason).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stream
// ─────────────────────────────────────────────────────────────────────────────

describe('stream', () => {
  async function collect(
    provider: OllamaProvider,
    request: Parameters<OllamaProvider['stream']>[0],
  ) {
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(request)) {
      events.push(event);
    }
    return events;
  }

  function ofType<T extends StreamEvent['type']>(
    events: readonly StreamEvent[],
    type: T,
  ): Array<Extract<StreamEvent, { type: T }>> {
    return events.filter((e) => e.type === type) as Array<Extract<StreamEvent, { type: T }>>;
  }

  it('reads newline-framed NDJSON (not SSE data:) and closes on done', async () => {
    const srv = await server((_req, res) =>
      ndjson(res, 200, [
        { model: 'llama3.1:8b', message: { role: 'assistant', content: '' }, done: false },
        { message: { role: 'assistant', content: 'Hel' }, done: false },
        { message: { role: 'assistant', content: 'lo' }, done: false },
        { done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 2 },
      ]),
    );
    const events = await collect(makeProvider(srv.url), {
      model: 'llama3.1:8b',
      messages: [],
      stream: true,
    });

    expect(events.map((e) => e.type)).toEqual(['start', 'text', 'text', 'usage', 'done']);
    expect(ofType(events, 'text')[0]?.delta).toBe('Hel');
    expect(ofType(events, 'text')[1]?.delta).toBe('lo');
    expect(ofType(events, 'usage')[0]?.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(ofType(events, 'done')[0]?.stopReason).toBe('end_turn');
  });

  it('emits a whole tool call as start + delta', async () => {
    const srv = await server((_req, res) =>
      ndjson(res, 200, [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'search', arguments: { q: 'x' } } }],
          },
          done: false,
        },
        { done: true, done_reason: 'stop' },
      ]),
    );
    const events = await collect(makeProvider(srv.url), { model: 'm', messages: [], stream: true });
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'tool_call_start',
      'tool_call_delta',
      'done',
    ]);
    expect(ofType(events, 'tool_call_start')[0]).toMatchObject({
      index: 0,
      id: 'search',
      name: 'search',
    });
    expect(ofType(events, 'tool_call_delta')[0]?.delta).toBe('{"q":"x"}');
  });

  it('never yields usage (or claims completion) when no done record closes the stream', async () => {
    const srv = await server((_req, res) =>
      ndjson(res, 200, [
        { message: { role: 'assistant', content: 'partial' }, done: false },
        // The daemon hung or was killed before emitting its terminal record.
      ]),
    );
    const events = await collect(makeProvider(srv.url), { model: 'm', messages: [], stream: true });
    expect(events.some((e) => e.type === 'usage')).toBe(false);
    const done = ofType(events, 'done')[0];
    // With no done_reason, the adapter must not claim a normal end.
    expect(done?.stopReason).toBe('unknown');
  });

  it('throws a clear error on an empty stream', async () => {
    const srv = await server((_req, res) => ndjson(res, 200, []));
    await expect(
      (async () => {
        for await (const _e of makeProvider(srv.url).stream({
          model: 'm',
          messages: [],
          stream: true,
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readNdjson / toToolCalls / toStopReason
// ─────────────────────────────────────────────────────────────────────────────

describe('readNdjson', () => {
  it('splits whole lines and flushes a trailing fragment without a newline', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}\n{"a":2}'));
        controller.close();
      },
    });
    const lines: unknown[] = [];
    for await (const line of readNdjson(body)) lines.push(line);
    expect(lines).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips a malformed line instead of aborting the stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not-json\n{"ok":true}\n'));
        controller.close();
      },
    });
    const lines: unknown[] = [];
    for await (const line of readNdjson(body)) lines.push(line);
    expect(lines).toEqual([{ ok: true }]);
  });
});

describe('toToolCalls', () => {
  it('keeps arguments byte-for-byte when they arrive as a string', () => {
    expect(toToolCalls([{ function: { name: 'f', arguments: '{"a": 1}' } }])).toEqual([
      { id: 'f', name: 'f', argumentsJson: '{"a": 1}' },
    ]);
  });

  it('serialises object arguments and skips entries with no name', () => {
    expect(
      toToolCalls([{ function: { arguments: { q: 1 } } }, { function: { name: 'g' } }]),
    ).toEqual([{ id: 'g', name: 'g', argumentsJson: '{}' }]);
  });

  it('returns an empty list for no tool calls', () => {
    expect(toToolCalls(undefined)).toEqual([]);
    expect(toToolCalls([])).toEqual([]);
  });
});

describe('toStopReason', () => {
  it('maps the documented values and closes on anything else', () => {
    expect(toStopReason('stop')).toBe('end_turn');
    expect(toStopReason('length')).toBe('max_tokens');
    expect(toStopReason('error')).toBe('error');
    expect(toStopReason('unload')).toBe('unknown');
    expect(toStopReason(undefined)).toBe('unknown');
    expect(toStopReason('invented')).toBe('unknown');
  });
});
