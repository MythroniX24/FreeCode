/**
 * Provider factory + catalogue tests.
 *
 * The factory is where the "never silently switch to a paid model" and "never
 * read a credential that is not needed" rules bite, so those are asserted
 * directly here:
 *
 *  - A provider that needs a key and has none configured throws an auth error.
 *  - A keyless provider (Ollama) is constructed with `apiKey === undefined` and
 *    is never asked for one.
 *  - The base URL resolves from config, else the built-in default.
 *  - The catalogue records billing provenance and never carries prices.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { AuthError, ConfigError } from '../src/errors.js';
import { withDefaults, providerConfigSchema, type FreecodeConfig } from '../src/config/schema.js';
import {
  BUILT_IN_PROVIDERS,
  adapterFor,
  builtInProvider,
  createProvider,
} from '../src/providers/registry.js';
import { clearRegisteredSecrets } from '../src/util/redact.js';
import type { CredentialStore } from '../src/auth/store.js';
import type { Logger } from '../src/util/logger.js';

const LOG: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => LOG,
} as unknown as Logger;

afterEach(() => clearRegisteredSecrets());

/** Build a config with the given provider blocks. */
function configWith(providers: Record<string, unknown>): FreecodeConfig {
  const parsed: Record<string, ReturnType<typeof providerConfigSchema.parse>> = {};
  for (const [id, block] of Object.entries(providers)) {
    parsed[id] = providerConfigSchema.parse(block);
  }
  return withDefaults({ providers: parsed } as never);
}

function inMemoryStore(values: Record<string, string>): CredentialStore {
  return {
    backend: 'file',
    secure: false,
    describe: () => 'memory (test)',
    async get(providerId) {
      return values[providerId];
    },
    async set() {},
    async delete() {
      return true;
    },
    async list() {
      return Object.keys(values);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// catalogue
// ─────────────────────────────────────────────────────────────────────────────

describe('BUILT_IN_PROVIDERS', () => {
  it('never carries a price anywhere in the catalogue', () => {
    const serialised = JSON.stringify(BUILT_IN_PROVIDERS);
    expect(serialised).not.toMatch(/[$€£]|\bprice\b|per-token|\bcost\b/i);
  });

  it('records billing provenance for every entry — no model is silently "free"', () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      expect(['free', 'free-tier', 'byok', 'paid', 'unknown']).toContain(provider.billing);
    }
    // Ollama is genuinely free (self-hosted, no metering). Everything else must
    // not be labelled purely free without verification.
    const ollama = builtInProvider('ollama');
    expect(ollama?.billing).toBe('free');
    expect(BUILT_IN_PROVIDERS.filter((p) => p.billing === 'free')).toEqual([ollama]);
  });

  it('every built-in carries a stable id, name, adapter and env vars', () => {
    for (const p of BUILT_IN_PROVIDERS) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.adapter.length).toBeGreaterThan(0);
      // Keyed providers must be keyed; the one keyless provider is Ollama.
      if (p.id === 'ollama') {
        expect(p.requiresApiKey).toBe(false);
        expect(p.apiKeyEnvVars).toEqual([]);
      } else {
        expect(p.requiresApiKey).toBe(true);
        expect(p.apiKeyEnvVars.length).toBeGreaterThan(0);
      }
    }
  });

  it('looks up by id and returns undefined for unknown ids', () => {
    expect(builtInProvider('groq')?.id).toBe('groq');
    expect(builtInProvider('not-a-provider')).toBeUndefined();
  });
});

describe('adapterFor', () => {
  it('maps config types onto adapter kinds', () => {
    expect(adapterFor({ type: 'anthropic' } as never)).toBe('anthropic');
    expect(adapterFor({ type: 'google' } as never)).toBe('google');
    expect(adapterFor({ type: 'ollama' } as never)).toBe('ollama');
    expect(adapterFor({ type: 'openai-compatible' } as never)).toBe('openai-compatible');
  });

  it('maps a built-in provider by its own adapter field', () => {
    expect(adapterFor(builtInProvider('groq')!)).toBe('openai-compatible');
    expect(adapterFor(builtInProvider('ollama')!)).toBe('ollama');
  });

  it('refuses to guess for gateway/custom — those are hosted mode only', () => {
    expect(() => adapterFor({ type: 'gateway' } as never)).toThrow(ConfigError);
    expect(() => adapterFor({ type: 'custom' } as never)).toThrow(ConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// factory
// ─────────────────────────────────────────────────────────────────────────────

describe('createProvider', () => {
  it('constructs a provider and resolves the key from the store', async () => {
    const config = configWith({ groq: { type: 'openai-compatible', enabled: true } });
    const {
      provider,
      baseUrl,
      config: resolved,
    } = await createProvider('groq', {
      config,
      store: inMemoryStore({ groq: 'gsk-groq-key' }),
      log: LOG,
    });
    expect(provider.info.id).toBe('groq');
    expect(provider.baseUrl).toBe(baseUrl);
    expect(baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(resolved.enabled).toBe(true);
  });

  it('resolves a custom base URL from config ahead of the built-in default', async () => {
    const config = configWith({
      groq: { type: 'openai-compatible', enabled: true, baseUrl: 'https://my-proxy.example' },
    });
    const { baseUrl } = await createProvider('groq', {
      config,
      store: inMemoryStore({ groq: 'k' }),
      log: LOG,
    });
    expect(baseUrl).toBe('https://my-proxy.example');
  });

  it('throws an auth error when a keyed provider has no key anywhere', async () => {
    const config = configWith({ groq: { type: 'openai-compatible', enabled: true } });
    await expect(
      createProvider('groq', { config, store: inMemoryStore({}), log: LOG }),
    ).rejects.toThrow(AuthError);
  });

  it('constructs a keyless Ollama without ever touching a credential', async () => {
    // The store must not even be consulted for a keyless provider.
    let getCalls = 0;
    const store: CredentialStore = {
      backend: 'file',
      secure: false,
      describe: () => 'memory (test)',
      async get() {
        getCalls += 1;
        return undefined;
      },
      async set() {},
      async delete() {
        return true;
      },
      async list() {
        return [];
      },
    };
    const config = configWith({ ollama: { type: 'ollama', enabled: true } });
    const { provider } = await createProvider('ollama', { config, store, log: LOG });
    expect(provider.info.requiresApiKey).toBe(false);
    expect(getCalls).toBe(0);
  });

  it('throws a config error for an unconfigured provider', async () => {
    const config = configWith({});
    await expect(createProvider('groq', { config, log: LOG })).rejects.toThrow(ConfigError);
  });

  it('throws when a provider is disabled', async () => {
    const config = configWith({ groq: { type: 'openai-compatible', enabled: false } });
    await expect(
      createProvider('groq', { config, store: inMemoryStore({ groq: 'k' }), log: LOG }),
    ).rejects.toThrow(ConfigError);
  });

  it('does not accept gateway/custom as an adapter the BYOK factory can build', async () => {
    const config = configWith({
      gw: { type: 'gateway', enabled: true, baseUrl: 'https://g.example', apiKeyEnv: 'GW_KEY' },
    });
    await expect(
      createProvider('gw', { config, store: inMemoryStore({ gw: 'k' }), log: LOG }),
    ).rejects.toThrow(ConfigError);
  });
});
