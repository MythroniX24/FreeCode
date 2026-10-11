/**
 * Test harness: a real gateway, a real HTTP server, a fake upstream.
 *
 * The gateway is assembled from the same `buildApp`/`startGateway` path
 * production uses, so a test cannot pass against a code path the deployment does
 * not take. The two substitutions are deliberate and named:
 *
 *  - **The usage store** is the memory store, with an injected clock so the
 *    quota windows can be exercised without sleeping.
 *  - **The provider resolver** is given a factory that returns a `StubProvider`,
 *    so no socket is ever opened to a real vendor.
 *
 * Everything else — Fastify, the authenticator, the quota limiter, the SSE
 * framing — is the production instance.
 */

import process from 'node:process';

import { Logger, memorySink, type ProviderConfig } from '@freecode/core';

import { parseGatewayConfig, type GatewayConfig } from '../../src/config.js';
import { QuotaLimiter } from '../../src/quota/limiter.js';
import { buildApp } from '../../src/server/app.js';
import { Authenticator } from '../../src/server/auth.js';
import type { RouteDeps } from '../../src/server/deps.js';
import type { UsageStore } from '../../src/store/types.js';
import { MemoryUsageStore } from '../../src/store/memory.js';
import { buildCatalogue } from '../../src/upstream/catalogue.js';
import { ProviderResolver } from '../../src/upstream/resolver.js';
import { StubProvider } from './stub-provider.js';
import type { FastifyInstance } from 'fastify';

export const TEST_API_KEY = 'gw-test-key-abcdefghijklmnop';

export interface HarnessOptions {
  /** Overrides merged over a minimal valid environment. */
  readonly env?: Record<string, string>;
  /** The stub provider the gateway will resolve. */
  readonly provider?: StubProvider;
  /** Provider config used to build the catalogue; defaults to one free model. */
  readonly providers?: Record<string, ProviderConfig>;
  readonly store?: UsageStore;
  /** Clock for the quota windows; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly deps: RouteDeps;
  readonly provider: StubProvider;
  readonly store: UsageStore;
  readonly sink: ReturnType<typeof memorySink>;
  /** Base URL of the running server, e.g. `http://127.0.0.1:54321`. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * A minimal provider config: one free, keyless upstream serving `test-model`.
 * Keyless ⇒ the catalogue resolves `unknown` billing to `free`, so it is served
 * without `GATEWAY_ALLOW_PAID_MODELS`.
 */
export function freeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    enabled: true,
    baseUrl: 'https://stub.invalid/v1',
    type: 'openai-compatible',
    models: ['test-model'],
    headers: {},
    timeoutMs: 60_000,
    maxConcurrency: 4,
    requireApproval: false,
    allowLoopbackHosts: [],
    billing: 'unknown',
    ...overrides,
  };
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const provider = options.provider ?? new StubProvider({ id: 'fake' });
  const providers = options.providers ?? { fake: freeProviderConfig() };

  const env: NodeJS.ProcessEnv = {
    GATEWAY_API_KEYS: TEST_API_KEY,
    GATEWAY_PROVIDERS: JSON.stringify(providers),
    GATEWAY_DEFAULT_PROVIDER: Object.keys(providers)[0] ?? 'fake',
    ...options.env,
  };
  const config: GatewayConfig = parseGatewayConfig(env);

  const store = options.store ?? new MemoryUsageStore();
  const sink = memorySink();
  const log = new Logger({ level: 'debug', format: 'text', sink, bindings: { test: true } });

  const resolver = new ProviderResolver({
    providers: config.providers,
    log,
    // The single substitution that keeps the suite off the network.
    createProviderFn: async () => ({
      provider,
      baseUrl: provider.baseUrl,
      config: providers[provider.info.id] ?? freeProviderConfig(),
    }),
  });
  await resolver.warm();

  const catalogue = buildCatalogue({
    config: resolver.appConfig,
    pricing: config.pricing,
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
  });

  const deps: RouteDeps = {
    startedAt: Date.now(),
    config,
    catalogue,
    resolver,
    authenticator: new Authenticator({ apiKeys: config.apiKeys, log }),
    limiter: new QuotaLimiter({
      limits: config.quota,
      store,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    store,
    log,
  };

  const app = buildApp({ deps });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  void address;

  const serverAddress = app.server.address();
  const port = typeof serverAddress === 'object' && serverAddress !== null ? serverAddress.port : 0;

  return {
    app,
    deps,
    provider,
    store,
    sink,
    url: `http://127.0.0.1:${port}`,
    async close(): Promise<void> {
      await app.close();
      await store.close();
    },
  };
}

/** `Authorization: Bearer` headers for the test key. */
export function authHeaders(key: string = TEST_API_KEY): Record<string, string> {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

/** POST JSON and return the parsed status, headers and text body. */
export async function postJson(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = authHeaders(),
): Promise<{ status: number; headers: Headers; text: string; json: unknown }> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: tryJson(text) };
}

/** GET and return the parsed status, headers and text body. */
export async function getJson(
  url: string,
  path: string,
  headers: Record<string, string> = authHeaders(),
): Promise<{ status: number; headers: Headers; text: string; json: unknown }> {
  const response = await fetch(`${url}${path}`, { headers });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: tryJson(text) };
}

/** Read SSE frames from a streaming response as `data:` payloads (or sentinel). */
export async function readSseFrames(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const payloads: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) payloads.push(line.slice(5).trim());
      }
    }
  }
  return payloads;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

process.on('unhandledRejection', () => undefined);
