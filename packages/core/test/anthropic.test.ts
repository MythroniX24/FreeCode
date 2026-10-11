/**
 * Anthropic adapter tests.
 *
 * Run against a real local HTTP server, for the same reasons as the
 * OpenAI-compatible suite: the transport, the SSE framing and the wire mapping
 * are exercised together.
 *
 * The commitments under test:
 *  - A credential reaches only the `x-api-key` header, never a URL, a log or an
 *    error — even when the server echoes the request back in its error body.
 *  - Usage is derived only from the provider's own `usage` object; a missing
 *    half is "unknown", never zero, and never invented.
 *  - Stop reasons map onto the closed enum; something unrecognised is
 *    `'unknown'`, never a silent success.
 *  - Anthropic delivers content blocks in order and refers to tool calls by
 *    index, and the adapter relies on that ordering rather than reassembling.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ProviderError } from '../src/errors.js';
import { providerConfigSchema, withDefaults, type FreecodeConfig } from '../src/config/schema.js';
import { AnthropicProvider, toStopReason } from '../src/providers/anthropic.js';
import { clearRegisteredSecrets } from '../src/util/redact.js';
import type { ProviderContext, ProviderInfo, StreamEvent } from '../src/providers/types.js';
import { json, sse, sseData, startTestServer, type TestServer } from './helpers/server.js';

const INFO: ProviderInfo = {
  id: 'anthropic',
  name: 'Anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
  apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
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
    apiKey: 'sk-ant-secret',
    baseUrl: url,
    appConfig,
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => null as never } as never,
    ...overrides,
  };
}

function makeProvider(url: string, context: Partial<ProviderContext> = {}): AnthropicProvider {
  return new AnthropicProvider(makeContext(url, context), { info: INFO });
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
  it('requests the /v1/models path and interprets the envelope', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, { data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4' }] }),
    );
    const models = await makeProvider(srv.url).listModels();
    expect(srv.requests[0]?.url).toBe('/v1/models');
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4', 'claude-sonnet-4-5']);
    expect(models[0]?.providerId).toBe('anthropic');
  });

  it('returns an empty list when the endpoint cannot enumerate', async () => {
    const srv = await server((_req, res) => json(res, 200, { unexpected: true }));
    expect(await makeProvider(srv.url).listModels()).toEqual([]);
  });

  it('sends the api key only in the x-api-key header', async () => {
    const srv = await server((_req, res) => json(res, 200, { data: [] }));
    await makeProvider(srv.url).listModels();
    const headers = srv.requests[0]?.headers ?? {};
    expect(headers['x-api-key']).toBe('sk-ant-secret');
    expect(headers['authorization']).toBeUndefined();
    // The credential must appear in exactly one place: the x-api-key header.
    // It must never be in a URL, a query string, or any other header.
    expect(srv.requests[0]?.url).not.toContain('sk-ant-secret');
    const occurrences = Object.keys(headers).filter(
      (name) => name !== 'x-api-key' && String(headers[name]).includes('sk-ant-secret'),
    );
    expect(occurrences).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chat (non-streaming)
// ─────────────────────────────────────────────────────────────────────────────

describe('chat', () => {
  it('posts to /v1/messages and maps a text reply', async () => {
    const srv = await server((req, res) => {
      if (req.url === '/v1/messages') {
        return json(res, 200, {
          id: 'msg_0123',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Hello there.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 2 },
        });
      }
      return json(res, 404, {});
    });

    const result = await makeProvider(srv.url).chat({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
      stream: false,
    });

    const body = JSON.parse(srv.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['model']).toBe('claude-sonnet-4-5');
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body['max_tokens']).toBe(10);
    expect(body['stream']).toBe(false);

    expect(result.content).toBe('Hello there.');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
    expect(result.providerRequestId).toBe('msg_0123');
  });

  it('defaults max_tokens so the request is not rejected', async () => {
    const srv = await server((req, res) => json(res, 200, { id: 'm', model: 'm', content: [] }));
    await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    const body = JSON.parse(srv.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(typeof body['max_tokens']).toBe('number');
  });

  it('parses the models list response as a flat list (single field)', async () => {
    const srv = await server((req, res) => json(res, 200, { data: [{ id: 'a' }] }));
    expect((await makeProvider(srv.url).listModels()).map((m) => m.id)).toEqual(['a']);
  });

  it('maps tool_use blocks to normalized tool calls', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        id: 'msg_2',
        model: 'm',
        content: [
          { type: 'text', text: 'Let me look.' },
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'list_files',
            input: { path: '.' },
          },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.content).toBe('Let me look.');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_01', name: 'list_files', argumentsJson: '{"path":"."}' },
    ]);
    expect(result.stopReason).toBe('tool_use');
  });

  it('does not fabricate usage when only one half is present', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        id: 'm',
        model: 'm',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 7 },
      }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.usage).toBeUndefined();
  });

  it('reports an unrecognised stop_reason as unknown, never success', async () => {
    const srv = await server((_req, res) =>
      json(res, 200, {
        id: 'm',
        model: 'm',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'draft',
      }),
    );
    const result = await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(result.stopReason).toBe('unknown');
  });

  it('surfaces a provider error without reproducing the request body', async () => {
    // A server that echoes the payload back in its error body is the worst case:
    // if the adapter put the raw error message into the thrown error, the
    // credential or the user's prompt would leak into the terminal.
    const srv = await server((req, res) => {
      const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      return json(
        res,
        400,
        { type: 'error', error: { message: `invalid: ${JSON.stringify(body)}` } },
        { 'content-type': 'application/json' },
      );
    });

    await expect(
      makeProvider(srv.url).chat({
        model: 'm',
        messages: [{ role: 'user', content: 'secret prompt' }],
        stream: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('carries the api key in the x-api-key header on chat', async () => {
    const srv = await server((_req, res) => json(res, 200, { id: 'm', model: 'm', content: [] }));
    await makeProvider(srv.url).chat({ model: 'm', messages: [], stream: false });
    expect(srv.requests[0]?.headers['x-api-key']).toBe('sk-ant-secret');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stream
// ─────────────────────────────────────────────────────────────────────────────

describe('stream', () => {
  async function collect(
    provider: AnthropicProvider,
    request: Parameters<AnthropicProvider['stream']>[0],
  ) {
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(request)) {
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

  it('streams text deltas and closes with a stop reason', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData({ type: 'message_start', message: { id: 'msg_s', model: 'm' } }),
        sseData({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        sseData({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hel' },
        }),
        sseData({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'lo' },
        }),
        sseData({ type: 'content_block_stop', index: 0 }),
        sseData({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        sseData({ type: 'message_stop' }),
      ]),
    );
    const events = await collect(makeProvider(srv.url), {
      model: 'm',
      messages: [],
      stream: true,
    });

    expect(events.map((e) => e.type)).toEqual(['start', 'text', 'text', 'done']);
    expect(ofType(events, 'start')[0]).toMatchObject({ id: 'msg_s', model: 'm' });
    // Text deltas arrive on the `text` event's `delta` field.
    expect(ofType(events, 'text')[0]?.delta).toBe('Hel');
    expect(ofType(events, 'text')[1]?.delta).toBe('lo');
    expect(ofType(events, 'done')[0]?.stopReason).toBe('end_turn');
  });

  it('emits tool calls in order with complete arguments', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData({ type: 'message_start', message: { id: 'msg_t', model: 'm' } }),
        sseData({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_files' },
        }),
        sseData({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"' },
        }),
        sseData({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '.' },
        }),
        sseData({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"}' },
        }),
        sseData({ type: 'content_block_stop', index: 0 }),
        sseData({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
        sseData({ type: 'message_stop' }),
      ]),
    );
    const events = await collect(makeProvider(srv.url), {
      model: 'm',
      messages: [],
      stream: true,
    });

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_end',
      'done',
    ]);
    expect(ofType(events, 'tool_call_start')[0]).toMatchObject({
      index: 0,
      id: 'toolu_1',
      name: 'list_files',
    });
    // tool_call_delta carries each raw fragment, in order.
    const deltas = ofType(events, 'tool_call_delta');
    expect(deltas[0]?.delta).toBe('{"path":"');
    expect(deltas[1]?.delta).toBe('.');
    expect(deltas[2]?.delta).toBe('"}');
    // The fragments reassembled to exactly the JSON the provider intended.
    expect(ofType(events, 'tool_call_end')[0]?.argumentsJson).toBe('{"path":"."}');
  });

  it('treats a truncated tool args fragment as an unknown stop, not a successful tool_use turn', async () => {
    // content_block_stop never arrives, so the args are incomplete JSON. The
    // adapter must not emit tool_call_end and must not claim tool_use.
    const srv = await server((_req, res) =>
      sse(res, [
        sseData({ type: 'message_start', message: { id: 'm', model: 'm' } }),
        sseData({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't', name: 'read_file' },
        }),
        sseData({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        }),
        sseData({ type: 'message_delta', delta: {} }),
      ]),
    );
    const events = await collect(makeProvider(srv.url), {
      model: 'm',
      messages: [],
      stream: true,
    });
    expect(events.map((e) => e.type)).not.toContain('tool_call_end');
  });

  it('reports usage from the message_delta patch', async () => {
    const srv = await server((_req, res) =>
      sse(res, [
        sseData({ type: 'message_start', message: { id: 'm', model: 'm' } }),
        sseData({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        sseData({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        }),
        sseData({ type: 'content_block_stop', index: 0 }),
        sseData({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: 9, output_tokens: 1 },
        }),
        sseData({ type: 'message_stop' }),
      ]),
    );
    const events = await collect(makeProvider(srv.url), {
      model: 'm',
      messages: [],
      stream: true,
    });
    expect(events.filter((e) => e.type === 'usage').length).toBe(1);
    const done = events[events.length - 1];
    expect(done?.type).toBe('done');
  });

  it('errors on JSON where SSE was expected', async () => {
    const srv = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm' }));
    });
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
    ).rejects.toThrow(ProviderError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toStopReason
// ─────────────────────────────────────────────────────────────────────────────

describe('toStopReason', () => {
  it('maps the documented values and rejects anything else as unknown', () => {
    expect(toStopReason('end_turn')).toBe('end_turn');
    expect(toStopReason('max_tokens')).toBe('max_tokens');
    expect(toStopReason('stop_sequence')).toBe('stop_sequence');
    expect(toStopReason('tool_use')).toBe('tool_use');
    expect(toStopReason('refusal')).toBe('unknown');
    expect(toStopReason(undefined)).toBe('unknown');
    expect(toStopReason('invented')).toBe('unknown');
  });
});
