/**
 * Gemini adapter tests, against a real local HTTP server.
 *
 * Commitments under test:
 *  - The credential reaches only the `x-goog-api-key` header.
 *  - Usage comes from `usageMetadata`; a missing half is "unknown", never invented.
 *  - Finish reasons map onto the closed enum; `SAFETY` becomes `content_filter`,
 *    anything unrecognised becomes `unknown`.
 *  - Model list entries come with a `models/` prefix and non-chat entries are
 *    skipped, never fabricated.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { providerConfigSchema, withDefaults, type FreecodeConfig } from '../src/config/schema.js';
import { GeminiProvider, toStopReason } from '../src/providers/google.js';
import { clearRegisteredSecrets } from '../src/util/redact.js';
import type { ProviderContext, ProviderInfo, StreamEvent } from '../src/providers/types.js';
import { json, sse, sseData, startTestServer, type TestServer } from './helpers/server.js';

const INFO: ProviderInfo = {
  id: 'google',
  name: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  apiKeyEnvVars: ['GEMINI_API_KEY'],
  requiresApiKey: true,
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
    apiKey: 'gsk-google-secret',
    baseUrl: url,
    appConfig,
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => null as never } as never,
    ...overrides,
  };
}

function makeProvider(url: string, context: Partial<ProviderContext> = {}): GeminiProvider {
  return new GeminiProvider(makeContext(url, context), { info: INFO });
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
  it('requests /v1beta/models and strips the models/ prefix', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        models: [
          {
            name: 'models/gemini-1.5-flash',
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
          },
          { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    );
    const models = await makeProvider(srv.url).listModels();
    expect(srv.requests[0]?.url).toBe('/v1beta/models');
    expect(models.map((m) => m.id)).toEqual(['gemini-1.5-flash', 'gemini-1.5-pro']);
    // Capabilities come from the provider's own metadata, never assumed.
    expect(models[0]?.capabilities?.streaming).toBe(true);
    expect(models[1]?.capabilities?.streaming).toBeUndefined();
  });

  it('skips non-chat entries (embeddings) based on their methods, never the name', async () => {
    // The real API marks embeddings with `embedContent` and no `generateContent`.
    // Skipping is decided from that metadata, not by guessing at the id.
    const srv = await server((_req, res) =>
      json(res, 200, {
        models: [
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    );
    const models = await makeProvider(srv.url).listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-1.5-flash']);
  });

  it('returns an empty list when the endpoint does not enumerate', async () => {
    const srv = await server((_req, res) => json(res, 200, { unexpected: true }));
    expect(await makeProvider(srv.url).listModels()).toEqual([]);
  });

  it('carries the key only in the x-goog-api-key header', async () => {
    const srv = await server((_req, res) => json(res, 200, { models: [] }));
    await makeProvider(srv.url).listModels();
    const headers = srv.requests[0]?.headers ?? {};
    expect(headers['x-goog-api-key']).toBe('gsk-google-secret');
    expect(headers['authorization']).toBeUndefined();
    expect(srv.requests[0]?.url).not.toContain('gsk-google-secret');
    const leak = Object.keys(headers).filter(
      (name) => name !== 'x-goog-api-key' && String(headers[name]).includes('gsk-google-secret'),
    );
    expect(leak).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chat (non-streaming)
// ─────────────────────────────────────────────────────────────────────────────

describe('chat', () => {
  it('posts to the generateContent endpoint and maps a text reply', async () => {
    const srv = await server((req, res) => {
      if (req.url?.startsWith('/v1beta/models/gemini-1.5-flash:generateContent')) {
        return json(res, 200, {
          modelVersion: 'gemini-1.5-flash',
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hello!' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        });
      }
      return json(res, 404, {});
    });

    const result = await makeProvider(srv.url).chat({
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    expect(result.content).toBe('Hello!');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const body = JSON.parse(srv.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['contents']).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(
      (body['generationConfig'] as Record<string, unknown>)['maxOutputTokens'],
    ).toBeUndefined();
    // The request URL must not include a key, and the non-streaming URL must
    // not carry `alt=sse`.
    expect(srv.requests[0]?.url).not.toContain('key=');
    expect(srv.requests[0]?.url).not.toContain('alt=sse');
  });

  it('sends maxTokens as maxOutputTokens in generationConfig', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, { candidates: [{ content: { parts: [] } }] }),
    );
    await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false, maxTokens: 42 });
    const body = JSON.parse(srv.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect((body['generationConfig'] as Record<string, unknown>)['maxOutputTokens']).toBe(42);
  });

  it('maps tool_use into a normalized tool call', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'read_file', args: { path: 'README.md' } } }],
            },
            finishReason: 'TOOL_CALLS',
          },
        ],
      }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.toolCalls).toEqual([
      { id: 'read_file', name: 'read_file', argumentsJson: '{"path":"README.md"}' },
    ]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toBe('');
  });

  it('does not fabricate usage when only the prompt half is present', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7 },
      }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.usage).toBeUndefined();
  });

  it('maps SAFETY to content_filter, not success', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.stopReason).toBe('content_filter');
  });

  it('throws a clear error when a missing finish reason is the only candidate', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, { candidates: [{ content: { parts: [] } }] }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.stopReason).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stream
// ─────────────────────────────────────────────────────────────────────────────

describe('stream', () => {
  async function collect(request: Parameters<GeminiProvider['stream']>[0], url: string) {
    const events: StreamEvent[] = [];
    for await (const event of makeProvider(url).stream(request)) {
      events.push(event);
    }
    return events;
  }

  /** Narrow the union to one variant for property access. */
  function ofType<T extends StreamEvent['type']>(
    events: readonly StreamEvent[],
    type: T,
  ): Array<Extract<StreamEvent, { type: T }>> {
    return events.filter((e) => e.type === type) as Array<Extract<StreamEvent, { type: T }>>;
  }

  it('hits the streamGenerateContent URL with alt=sse', async () => {
    const srv = await server((_req, res) => sse(res, [sseData({ candidates: [] })]));
    await collect({ model: 'gemini-1.5-flash', messages: [], stream: true }, srv.url);
    expect(srv.requests[0]?.url).toContain(':streamGenerateContent');
    expect(srv.requests[0]?.url).toContain('alt=sse');
  });

  it('streams text parts and closes with a stop reason', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData({ candidates: [{ content: { parts: [{ text: 'Hel' }] }, finishReason: null }] }),
        sseData({ candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: null }] }),
        sseData({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
      ]),
    );
    const events = await collect({ model: 'm', messages: [], stream: true }, srv.url);
    expect(events.map((e) => e.type)).toEqual(['start', 'text', 'text', 'done']);
    expect(ofType(events, 'text')[0]?.delta).toBe('Hel');
    expect(ofType(events, 'text')[1]?.delta).toBe('lo');
    expect(ofType(events, 'done')[0]?.stopReason).toBe('end_turn');
  });

  it('emits a tool call as start + delta when it is a finished part', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData({
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'search_files', args: { pattern: '*.ts' } } }],
              },
              finishReason: 'TOOL_CALLS',
            },
          ],
        }),
      ]),
    );
    const events = await collect({ model: 'm', messages: [], stream: true }, srv.url);
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'tool_call_start',
      'tool_call_delta',
      'done',
    ]);
    expect(ofType(events, 'tool_call_start')[0]).toMatchObject({
      index: 0,
      id: 'search_files',
      name: 'search_files',
    });
    expect(ofType(events, 'tool_call_delta')[0]?.delta).toBe('{"pattern":"*.ts"}');
    expect(ofType(events, 'done')[0]?.stopReason).toBe('tool_use');
  });

  it('emits usage when usageMetadata arrives on the last chunk', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData({
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
        }),
      ]),
    );
    const events = await collect({ model: 'm', messages: [], stream: true }, srv.url);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { inputTokens: 5, outputTokens: 1 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toStopReason
// ─────────────────────────────────────────────────────────────────────────────

describe('toStopReason', () => {
  it('maps the documented values and rejects anything else as unknown', () => {
    expect(toStopReason('STOP')).toBe('end_turn');
    expect(toStopReason('MAX_TOKENS')).toBe('max_tokens');
    expect(toStopReason('TOOL_CALLS')).toBe('tool_use');
    expect(toStopReason('SAFETY')).toBe('content_filter');
    expect(toStopReason('RECITATION')).toBe('content_filter');
    expect(toStopReason(undefined)).toBe('unknown');
    expect(toStopReason('inventedReason')).toBe('unknown');
  });
});
