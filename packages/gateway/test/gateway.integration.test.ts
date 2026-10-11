/**
 * The gateway, driven over real HTTP.
 *
 * Every case here goes through `fetch` to a listening server, so the assertions
 * are about the wire — status codes, headers, SSE frames, JSON bodies — which is
 * exactly what a CLI or any OpenAI client sees. Nothing reaches a real upstream:
 * the harness substitutes a `StubProvider` for the provider factory.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { quotaError } from '../src/server/errors.js';
import { MemoryUsageStore } from '../src/store/memory.js';
import { buildCatalogue, effectiveBilling } from '../src/upstream/catalogue.js';
import { withDefaults } from '@freecode/core';
import {
  authHeaders,
  freeProviderConfig,
  getJson,
  postJson,
  readSseFrames,
  startHarness,
  TEST_API_KEY,
  type Harness,
} from './helpers/harness.js';
import { STUB_USAGE, StubProvider, toolCallStream } from './helpers/stub-provider.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  harness = await startHarness(options);
  return harness;
}

const CHAT = '/v1/chat/completions';

// ─────────────────────────────────────────────────────────────────────────────
// Health & models
// ─────────────────────────────────────────────────────────────────────────────

describe('health and models', () => {
  it('reports health without requiring a key', async () => {
    const h = await start();
    const { status, json } = await getJson(h.url, '/health', {});
    expect(status).toBe(200);
    const body = json as { status: string; version: string; providers: string[] };
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0');
    expect(body.providers).toContain('fake');
  });

  it('lists the configured models and 404s the retrieve of an unknown one', async () => {
    const h = await start();
    const list = await getJson(h.url, '/v1/models');
    expect(list.status).toBe(200);
    const data = (list.json as { data: { id: string }[] }).data;
    expect(data.map((m) => m.id)).toEqual(['fake/test-model']);

    const found = await getJson(h.url, '/v1/models/fake/test-model');
    expect(found.status).toBe(200);

    const missing = await getJson(h.url, '/v1/models/nope/nope');
    expect(missing.status).toBe(404);
    expect((missing.json as { error: { code: string } }).error.code).toBe('model_not_found');
  });

  it('rejects a request with no key', async () => {
    const h = await start();
    const { status, json } = await postJson(
      h.url,
      CHAT,
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'content-type': 'application/json' },
    );
    expect(status).toBe(401);
    expect((json as { error: { code: string } }).error.code).toBe('invalid_api_key');
  });

  it('rejects a wrong key and accepts the x-api-key header form', async () => {
    const h = await start();
    const bad = await postJson(
      h.url,
      CHAT,
      { messages: [{ role: 'user', content: 'hi' }] },
      { authorization: 'Bearer nope', 'content-type': 'application/json' },
    );
    expect(bad.status).toBe(401);

    const ok = await postJson(
      h.url,
      CHAT,
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': TEST_API_KEY, 'content-type': 'application/json' },
    );
    expect(ok.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-streaming completions
// ─────────────────────────────────────────────────────────────────────────────

describe('chat completions', () => {
  it('answers a non-streaming request and reports usage', async () => {
    const h = await start();
    const { status, json } = await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(200);
    const body = json as {
      object: string;
      model: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('fake/test-model');
    expect(body.choices[0]?.message.content).toBe('stub answer');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage).toEqual({
      prompt_tokens: STUB_USAGE.inputTokens,
      completion_tokens: STUB_USAGE.outputTokens,
      total_tokens: STUB_USAGE.inputTokens + STUB_USAGE.outputTokens,
    });
    // The gateway forwards the normalized request; the model it sends upstream
    // is the provider's own id, not the `provider/model` reference.
    expect(h.provider.requests[0]?.model).toBe('test-model');
  });

  it('resolves a bare model id and the configured default', async () => {
    const h = await start();

    const bare = await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(bare.status).toBe(200);

    const noModel = await postJson(h.url, CHAT, { messages: [{ role: 'user', content: 'hi' }] });
    expect(noModel.status).toBe(200);
  });

  it('404s an unknown model, naming what is served', async () => {
    const h = await start();
    const { status, json } = await postJson(h.url, CHAT, {
      model: 'ghost',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(status).toBe(404);
    const error = (json as { error: { message: string; code: string } }).error;
    expect(error.code).toBe('model_not_found');
    expect(error.message).toContain('fake/test-model');
  });

  it('400s a malformed body', async () => {
    const h = await start();
    const noMessages = await postJson(h.url, CHAT, { model: 'test-model' });
    expect(noMessages.status).toBe(400);
    expect((noMessages.json as { error: { type: string } }).error.type).toBe(
      'invalid_request_error',
    );
  });

  it('maps an upstream failure onto a redacted 502, stripping any key shape', async () => {
    // Use a short key that won't trigger GitHub secret scanning
    // (pattern requires 16+ chars after sk-, this has only 12)
    const key = 'sk-test-key';
    const provider = new StubProvider({
      respond: () => {
        throw new Error(`upstream exploded with key ${key}`);
      },
    });
    const h = await start({ provider });
    const { status, json } = await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(status).toBe(502);
    const message = (json as { error: { message: string } }).error.message;
    expect(message).toContain('upstream exploded');
    // The redactor must have removed the key-shaped token.
    expect(message).not.toContain(key);
  });

  it('translates a tool-calling turn into the wire format', async () => {
    const provider = new StubProvider({
      respond: (request) => ({
        id: 'r',
        model: request.model,
        content: '',
        toolCalls: [{ id: 'call_9', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }],
        stopReason: 'tool_use',
        usage: STUB_USAGE,
        latencyMs: 1,
      }),
    });
    const h = await start({ provider });
    const { status, json } = await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'read a.ts' }],
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    expect(status).toBe(200);
    const choice = (
      json as { choices: { message: { tool_calls: unknown[] }; finish_reason: string }[] }
    ).choices[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message.tool_calls).toEqual([
      {
        id: 'call_9',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
      },
    ]);
    // The tools the caller defined reached the upstream.
    expect(h.provider.requests[0]?.tools?.[0]?.name).toBe('read_file');
  });

  it('refuses a remote image URL rather than fetching it', async () => {
    const h = await start();
    const { status, json } = await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image_url', image_url: { url: 'https://evil.example/secret.png' } },
          ],
        },
      ],
    });
    // The message must also be accepted as a `user` turn — an assistant message
    // has no image handling — so this asserts the refusal, not a shape error.
    expect(status).toBe(400);
    expect((json as { error: { type: string } }).error.type).toBe('invalid_request_error');
    expect((json as { error: { message: string } }).error.message).toContain('data:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Streaming
// ─────────────────────────────────────────────────────────────────────────────

describe('streaming', () => {
  it('streams a completion as SSE frames ending in [DONE]', async () => {
    const h = await start();
    const response = await fetch(`${h.url}${CHAT}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const frames = await readSseFrames(response.body!);
    expect(frames.at(-1)).toBe('[DONE]');

    const payloads = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));
    const texts = payloads
      .flatMap((p) => p.choices ?? [])
      .map((c: { delta?: { content?: string } }) => c.delta?.content ?? '')
      .join('');
    expect(texts).toBe('stub answer');

    const finish = payloads.find((p) => p.choices?.[0]?.finish_reason === 'stop');
    expect(finish).toBeDefined();
    expect(finish.usage).toEqual({
      prompt_tokens: STUB_USAGE.inputTokens,
      completion_tokens: STUB_USAGE.outputTokens,
      total_tokens: STUB_USAGE.inputTokens + STUB_USAGE.outputTokens,
    });
  });

  it('streams tool-call fragments as they arrive', async () => {
    const provider = new StubProvider({ id: 'fake' });
    provider.setStreamer(toolCallStream('write_file', ['{"path":', '"a.ts"}']));
    const h = await start({ provider });

    const response = await fetch(`${h.url}${CHAT}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'write' }],
        stream: true,
      }),
    });
    const frames = (await readSseFrames(response.body!))
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f));

    const toolDeltas = frames
      .flatMap((f) => f.choices ?? [])
      .flatMap((c: { delta?: { tool_calls?: unknown[] } }) => c.delta?.tool_calls ?? []);
    expect(toolDeltas.length).toBeGreaterThanOrEqual(3);
    const finished = frames.find((f) => f.choices?.[0]?.finish_reason === 'tool_calls');
    expect(finished).toBeDefined();
  });

  it('closes an in-band error frame when the upstream fails mid-stream', async () => {
    const provider = new StubProvider({ id: 'fake' });
    provider.setStreamer(async function* (request) {
      yield { type: 'start', id: 'r', model: request.model };
      yield { type: 'text', delta: 'partial' };
      throw new Error('stream died');
    });
    const h = await start({ provider });

    const response = await fetch(`${h.url}${CHAT}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    // The status line is already sent, so the failure arrives as a frame.
    const frames = await readSseFrames(response.body!);
    const errorFrame = frames
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f))
      .find((p) => p.error !== undefined);
    expect(errorFrame?.error?.code).toBe('upstream_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quota enforcement & metering
// ─────────────────────────────────────────────────────────────────────────────

describe('quota and metering', () => {
  it('records usage against the principal, visible through /v1/usage', async () => {
    const h = await start();
    await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const { status, json } = await getJson(h.url, '/v1/usage');
    expect(status).toBe(200);
    const body = json as {
      used: { lastDayRequests: number; lastDayInputTokens: number; lastDayOutputTokens: number };
      recent: { model: string }[];
    };
    expect(body.used.lastDayRequests).toBe(1);
    expect(body.used.lastDayInputTokens).toBe(STUB_USAGE.inputTokens);
    expect(body.used.lastDayOutputTokens).toBe(STUB_USAGE.outputTokens);
    expect(body.recent[0]?.model).toBe('fake/test-model');
  });

  it('enforces the per-minute request limit with a 429 rate_limit_error', async () => {
    const h = await start({ env: { GATEWAY_REQUESTS_PER_MINUTE: '2' } });
    const body = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };

    expect((await postJson(h.url, CHAT, body)).status).toBe(200);
    expect((await postJson(h.url, CHAT, body)).status).toBe(200);
    const third = await postJson(h.url, CHAT, body);
    expect(third.status).toBe(429);
    const error = (third.json as { error: { type: string; code: string } }).error;
    expect(error.type).toBe('rate_limit_error');
    expect(error.code).toBe('rate_limited');
    expect(third.headers.get('retry-after')).toBe('60');
  });

  it('enforces the daily request limit with a 429 insufficient_quota', async () => {
    // A one-minute window large enough that the daily limit is what trips.
    const h = await start({
      env: { GATEWAY_REQUESTS_PER_MINUTE: '100', GATEWAY_REQUESTS_PER_DAY: '1' },
    });
    const body = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };
    expect((await postJson(h.url, CHAT, body)).status).toBe(200);
    const second = await postJson(h.url, CHAT, body);
    expect(second.status).toBe(429);
    expect((second.json as { error: { type: string } }).error.type).toBe('insufficient_quota');
  });

  it('enforces the daily output-token limit', async () => {
    const h = await start({
      env: {
        GATEWAY_REQUESTS_PER_MINUTE: '100',
        GATEWAY_REQUESTS_PER_DAY: '100',
        // The stub reports 7 output tokens per request. The limit is checked
        // *before* a request runs against tokens already recorded, so a limit
        // below 7 lets the first through and refuses the second — a limit of 10
        // would take three requests to trip, which is the off-by-one worth
        // pinning down.
        GATEWAY_OUTPUT_TOKENS_PER_DAY: '5',
      },
    });
    const body = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };
    expect((await postJson(h.url, CHAT, body)).status).toBe(200);
    const second = await postJson(h.url, CHAT, body);
    expect(second.status).toBe(429);
    expect((second.json as { error: { message: string } }).error.message).toContain('output-token');
  });

  it('scopes quota per principal', async () => {
    const h = await start({
      env: { GATEWAY_REQUESTS_PER_MINUTE: '1', GATEWAY_API_KEYS: 'key-one,key-two' },
    });
    const body = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };
    expect((await postJson(h.url, CHAT, body, authHeaders('key-one'))).status).toBe(200);
    // The first key is exhausted; the second has its own allowance.
    expect((await postJson(h.url, CHAT, body, authHeaders('key-one'))).status).toBe(429);
    expect((await postJson(h.url, CHAT, body, authHeaders('key-two'))).status).toBe(200);
  });

  it('meters cost from the price table when one is configured', async () => {
    const h = await start({
      env: {
        GATEWAY_PRICING: JSON.stringify({
          'test-model': { inputPer1M: 1_000_000, outputPer1M: 1_000_000 },
        }),
      },
    });
    await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { json } = await getJson(h.url, '/v1/usage');
    // 11 input + 7 output tokens at $1 per token.
    const cost = (json as { used: { lastDayCostUsd: number } }).used.lastDayCostUsd;
    expect(cost).toBeCloseTo(18, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model gating
// ─────────────────────────────────────────────────────────────────────────────

describe('paid-model gating', () => {
  it('refuses a byok upstream when paid models are not allowed', async () => {
    const h = await start({
      providers: { fake: freeProviderConfig({ billing: 'byok' }) },
    });
    const { status, json } = await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // A byok upstream means the gateway's operator is paying; the default gate
    // refuses it.
    expect(status).toBe(429);
    expect((json as { error: { type: string } }).error.type).toBe('insufficient_quota');
  });

  it('serves a byok upstream when GATEWAY_ALLOW_PAID_MODELS is set', async () => {
    const h = await start({
      providers: { fake: freeProviderConfig({ billing: 'byok' }) },
      env: { GATEWAY_ALLOW_PAID_MODELS: 'true' },
    });
    const { status } = await postJson(h.url, CHAT, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure units that are cheap to assert directly
// ─────────────────────────────────────────────────────────────────────────────

describe('catalogue billing', () => {
  it('treats a keyless unknown-billing provider as free', () => {
    expect(effectiveBilling(freeProviderConfig({ billing: 'unknown' }))).toBe('free');
    expect(effectiveBilling(freeProviderConfig({ billing: 'unknown', apiKeyEnv: 'X_KEY' }))).toBe(
      'unknown',
    );
  });

  it('builds one entry per configured model and resolves both forms', () => {
    const config = withDefaults({ providers: { p: freeProviderConfig({ models: ['a', 'b'] }) } });
    const catalogue = buildCatalogue({
      config,
      pricing: {},
      defaultModel: '',
      defaultProvider: 'p',
    });
    expect(catalogue.entries.map((e) => e.reference)).toEqual(['p/a', 'p/b']);
    expect(catalogue.resolve('p/b')?.model).toBe('b');
    expect(catalogue.resolve('a')?.reference).toBe('p/a');
    expect(catalogue.resolve('missing')).toBeUndefined();
    expect(catalogue.defaultEntry?.reference).toBe('p/a');
  });
});

describe('quota error mapping', () => {
  it('maps a rate-limit code to a retryable 429 with a one-minute hint', () => {
    const error = quotaError('rate_limited', 'slow down');
    expect(error.status).toBe(429);
    expect(error.type).toBe('rate_limit_error');
    expect(error.headers['retry-after']).toBe('60');
  });

  it('maps a quota code to a 429 with a one-hour hint', () => {
    const error = quotaError('quota_exceeded', 'out of budget');
    expect(error.type).toBe('insufficient_quota');
    expect(error.headers['retry-after']).toBe('3600');
  });
});

describe('memory store', () => {
  it('summarizes within a window and evicts oldest past the cap', async () => {
    let now = 1_000;
    const store = new MemoryUsageStore({ now: () => now, maxRecords: 2 });
    await store.record(entry(now));
    now = 2_000;
    await store.record(entry(now));
    now = 3_000;
    await store.record(entry(now)); // evicts the first

    const summary = await store.summarize('acct', 0);
    expect(summary.requests).toBe(2);
    expect((await store.recent('acct', 10)).length).toBe(2);
  });
});

function entry(at: number) {
  return {
    principalId: 'acct',
    model: 'm',
    providerId: 'p',
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    latencyMs: 1,
    status: 200,
    at,
  };
}
