/**
 * Provider discovery tests.
 *
 * `discoverProviders` lives at the seam between the factory (which resolves a
 * real credential) and the adapter (which talks to a real endpoint). Those two
 * tails are already covered elsewhere; what is tested here is the policy logic
 * around them:
 *
 *  - A fresh cache entry short-circuits the live fetch and is marked as such.
 *  - A live fetch that fails falls back to the stale cache; one with no cache at
 *    all is reported as a failure (never padded with invented models).
 *  - Results are written back atomically under 0600.
 *  - Pinning models in config keeps them routable even when the provider is
 *    offline (`configuredModelIds`).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { withDefaults, providerConfigSchema, type FreecodeConfig } from '../src/config/schema.js';
import { configuredModelIds, discoverProviders } from '../src/models/discovery.js';
import { writeRegistryCache } from '../src/models/registry.js';
import type { Provider, ModelDescriptor } from '../src/providers/types.js';
import type { CredentialStore } from '../src/auth/store.js';
import type { Logger } from '../src/util/logger.js';

const LOG: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => LOG,
} as unknown as Logger;

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freecode-discovery-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function configWith(providers: Record<string, unknown>): FreecodeConfig {
  const parsed: Record<string, ReturnType<typeof providerConfigSchema.parse>> = {};
  for (const [id, block] of Object.entries(providers)) {
    parsed[id] = providerConfigSchema.parse(block);
  }
  return withDefaults({ providers: parsed } as never);
}

function fakeList(ids: readonly string[]): (provider: Provider) => Promise<ModelDescriptor[]> {
  return async () => ids.map((id) => ({ id, providerId: 'x' }));
}

const KEY = { groq: 'gsk-groq' };
const STORE: CredentialStore = {
  backend: 'file',
  secure: false,
  describe: () => 'memory (test)',
  async get(providerId) {
    return KEY[providerId as keyof typeof KEY];
  },
  async set() {},
  async delete() {
    return true;
  },
  async list() {
    return Object.keys(KEY);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// discoverProviders
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverProviders', () => {
  it('fetches a live list and writes it to the cache', async () => {
    const dir = await tempDir();
    const config = configWith({ groq: { type: 'openai-compatible', enabled: true } });
    const results = await discoverProviders({
      config,
      store: STORE,
      log: LOG,
      listModels: fakeList(['a', 'b']),
      cacheDir: dir,
    });

    expect(results).toEqual([
      expect.objectContaining({
        providerId: 'groq',
        ok: true,
        modelIds: ['a', 'b'],
        fromCache: false,
      }),
    ]);

    const cached = JSON.parse(await fs.readFile(path.join(dir, 'groq.json'), 'utf8')) as {
      modelIds: string[];
    };
    expect(cached.modelIds).toEqual(['a', 'b']);
  });

  it('serves a fresh cache entry without contacting the provider', async () => {
    const dir = await tempDir();
    const config = configWith({ groq: { type: 'openai-compatible', enabled: true } });
    await writeRegistryCache('groq', ['cached-model'], { dir });

    let liveCalls = 0;
    const results = await discoverProviders({
      config,
      store: STORE,
      log: LOG,
      listModels: async () => {
        liveCalls += 1;
        return [{ id: 'should-not-run', providerId: 'groq' }];
      },
      cacheDir: dir,
    });

    expect(liveCalls).toBe(0);
    expect(results[0]).toMatchObject({
      providerId: 'groq',
      ok: true,
      modelIds: ['cached-model'],
      fromCache: true,
    });
  });

  it('falls back to a stale cache when the live fetch fails', async () => {
    const dir = await tempDir();
    const config = configWith({ groq: { type: 'openai-compatible', enabled: true } });
    // pin the fetchedAt far in the past so it is stale under the 24h TTL.
    await fs.writeFile(
      path.join(dir, 'groq.json'),
      JSON.stringify({
        providerId: 'groq',
        fetchedAt: '2000-01-01T00:00:00Z',
        modelIds: ['stale'],
      }),
      { mode: 0o600 },
    );

    const results = await discoverProviders({
      config,
      store: STORE,
      log: LOG,
      listModels: async () => {
        throw new Error('provider unreachable');
      },
      cacheDir: dir,
    });

    expect(results[0]).toMatchObject({
      providerId: 'groq',
      ok: true,
      modelIds: ['stale'],
      fromCache: true,
    });
  });

  it('reports a failure honestly when there is no cache to fall back to', async () => {
    const dir = await tempDir();
    const config = configWith({ groq: { type: 'openai-compatible', enabled: true } });
    const results = await discoverProviders({
      config,
      store: STORE,
      log: LOG,
      listModels: async () => {
        throw new Error('connection refused');
      },
      cacheDir: dir,
    });
    expect(results[0]).toMatchObject({
      providerId: 'groq',
      ok: false,
      modelIds: [],
      fromCache: false,
    });
    expect(results[0]?.error).toContain('connection refused');
  });

  it('skips disabled providers', async () => {
    const dir = await tempDir();
    const config = configWith({
      groq: { type: 'openai-compatible', enabled: true },
      anthropic: { type: 'anthropic', enabled: false },
    });
    const results = await discoverProviders({
      config,
      store: STORE,
      log: LOG,
      listModels: fakeList(['x']),
      cacheDir: dir,
    });
    expect(results.map((r) => r.providerId)).toEqual(['groq']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// configuredModelIds
// ─────────────────────────────────────────────────────────────────────────────

describe('configuredModelIds', () => {
  it('collects pinned models from enabled providers', () => {
    const config = configWith({
      groq: { type: 'openai-compatible', enabled: true, models: ['llama-3.3-70b-versatile'] },
      ollama: { type: 'ollama', enabled: true, models: ['llama3'] },
    });
    expect(configuredModelIds(config)).toEqual({
      groq: ['llama-3.3-70b-versatile'],
      ollama: ['llama3'],
    });
  });

  it('ignores disabled providers and empty pins', () => {
    const config = configWith({
      groq: { type: 'openai-compatible', enabled: false, models: ['x'] },
      ollama: { type: 'ollama', enabled: true, models: [] },
    });
    expect(configuredModelIds(config)).toEqual({});
  });
});
