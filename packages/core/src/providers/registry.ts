/**
 * The provider factory and catalogue.
 *
 * Two jobs, deliberately separate:
 *
 *  - **Built-in catalogue** (`BUILT_IN_PROVIDERS`): the named providers this
 *    build knows how to reach. Each carries its `billing` provenance and the
 *    adapter type and env var it uses. Crucially, the catalogue never invents
 *    model ids, prices, or "free" claims — it records what the vendor documents
 *    and lets discovery/probing verify what actually works.
 *
 *  - **Factory** (`createProvider`): turns a named provider + resolved config +
 *    resolved key into a `Provider` instance. The key comes from the credential
 *    store *only* when the provider actually requires one; a self-hosted Ollama
 *    gets `undefined` and is never asked for a secret.
 *
 * Security commitments:
 *
 *  - A provider's base URL is validated by the SSRF guard inside `HttpClient`;
 *    the factory never skips that. Loopback hosts are only permitted as
 *    configured (`ollama` defaults to `localhost`, which the guard allows as an
 *    explicit loopback host).
 *  - The resolved API key is held in the `ProviderContext` and used only by the
 *    adapter's header code. It is never logged, never placed in a URL, and never
 *    written to config (only the env var *name* is ever stored).
 *  - A provider whose key cannot be resolved is reported as a missing-credential
 *    error, never silently run keyless.
 */

import { AuthError, ConfigError } from '../errors.js';
import type { FreecodeConfig, ProviderConfig } from '../config/schema.js';
import { missingCredentialError, resolveApiKey, type CredentialStore } from '../auth/store.js';
import type { Logger } from '../util/logger.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { Provider, ProviderContext, ProviderInfo } from './types.js';

/** The provider `type` values the factory can construct. */
export const ADAPTER_TYPES = ['openai-compatible', 'anthropic', 'google', 'ollama'] as const;
export type AdapterType = (typeof ADAPTER_TYPES)[number];

/**
 * A named provider the CLI can be pointed at by `freecode providers add <id>`.
 *
 * `apiKeyEnvVars` holds the environment variable *names* checked, in order. The
 * key itself is never embedded.
 */
export interface BuiltInProvider {
  readonly id: string;
  readonly name: string;
  readonly adapter: AdapterType;
  readonly defaultBaseUrl: string;
  readonly apiKeyEnvVars: readonly string[];
  /** Whether this provider needs a key at all. `false` for self-hosted. */
  readonly requiresApiKey: boolean;
  /**
   * The billing provenance, used by the "never silently switch to paid" rule.
   * `'free'` means the vendor documents a genuinely free tier; `'byok'` means
   * the user pays their own key's usage; `'paid'` is a metered vendor; and
   * `'unknown'` is recorded when the model's billing cannot be verified — the
   * routing engine treats `'unknown'` as *not* free, never the reverse.
   */
  readonly billing: 'free' | 'free-tier' | 'byok' | 'paid' | 'unknown';
  /** Stable web reference, for configuration help. */
  readonly docsUrl?: string;
  readonly termsUrl?: string;
  /** Why this provider is or is not recommended, shown by `providers list`. */
  readonly notes?: string;
}

/**
 * The built-in catalogue. Prices are deliberately absent: FreeCode never
 * fabricates per-token costs — those change far too often to be trusted from a
 * bundled table, and the "free" claim is a *claim* recorded from the vendor's
 * docs, verified by the probe, never assumed.
 */
export const BUILT_IN_PROVIDERS: readonly BuiltInProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    adapter: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
    requiresApiKey: true,
    billing: 'byok',
    docsUrl: 'https://docs.anthropic.com',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    adapter: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    apiKeyEnvVars: ['GEMINI_API_KEY', 'GEMINI_API_KEY_BAK'],
    requiresApiKey: true,
    billing: 'free-tier',
    docsUrl: 'https://ai.google.dev',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    adapter: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVars: ['OPENROUTER_API_KEY'],
    requiresApiKey: true,
    billing: 'byok',
    docsUrl: 'https://openrouter.ai',
  },
  {
    id: 'groq',
    name: 'Groq',
    adapter: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVars: ['GROQ_API_KEY'],
    requiresApiKey: true,
    billing: 'free-tier',
    docsUrl: 'https://console.groq.com',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    adapter: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    apiKeyEnvVars: [],
    requiresApiKey: false,
    billing: 'free',
    docsUrl: 'https://ollama.com',
    notes:
      'Self-hosted; no API key. Bind the daemon to 127.0.0.1 unless you know what you are doing.',
  },
];

/** Look up a built-in by id. */
export function builtInProvider(id: string): BuiltInProvider | undefined {
  return BUILT_IN_PROVIDERS.find((p) => p.id === id);
}

/**
 * Map a configured provider `type` onto the adapter class the factory uses.
 *
 * `gateway` and `custom` are not constructible here: they are handled by the
 * hosted gateway, so the factory fails loudly rather than guessing.
 */
export function adapterFor(provider: BuiltInProvider | ProviderConfig): AdapterType {
  if ('adapter' in provider) return provider.adapter;
  const type = provider.type;
  if (type === 'anthropic') return 'anthropic';
  if (type === 'google') return 'google';
  if (type === 'ollama') return 'ollama';
  if (type === 'openai-compatible') return 'openai-compatible';
  // 'gateway' and 'custom' fall through to the exhaustive guard in the factory.
  throw new ConfigError(
    `Provider type “${type}” is handled by the hosted gateway, not the BYOK factory.`,
  );
}

export interface ProviderFactoryOptions {
  /** The full resolved config. */
  readonly config: FreecodeConfig;
  /** Credential store used to resolve the API key. Optional for keyless providers. */
  readonly store?: CredentialStore;
  /** Logger for adapter internals. */
  readonly log: Logger;
}

export interface CreateProviderResult {
  readonly provider: Provider;
  /** Resolved base URL, for display and diagnostics. */
  readonly baseUrl: string;
  /** The configured provider config that was consumed. */
  readonly config: ProviderConfig;
}

/**
 * Build a `Provider` instance from its configured type + resolved key.
 *
 * The provider is resolved from the *config* (which may point at a built-in or a
 * fully custom entry), so `freecode providers add` specializes by writing config,
 * and this factory only reads.
 */
export async function createProvider(
  providerId: string,
  options: ProviderFactoryOptions,
): Promise<CreateProviderResult> {
  const { log } = options;
  const config = options.config.providers[providerId];
  if (config === undefined) {
    throw new ConfigError(`Provider “${providerId}” is not configured.`, {
      hint: `Add it with “freecode providers add ${providerId}”, or set its config block.`,
    });
  }
  if (config.enabled === false) {
    throw new ConfigError(`Provider “${providerId}” is disabled.`, {
      hint: 'Enable it in config, or pick another provider.',
    });
  }

  const builtIn = builtInProvider(providerId);
  const baseUrl = resolveBaseUrl(config, builtIn);
  const info = toProviderInfo(providerId, builtIn, config);

  // Resolve the key *only* when the provider needs one. A self-hosted Ollama is
  // never asked for a secret; that would be a licence to read credentials that
  // are not needed, and this project never touches `.env`/keys uninvited.
  let apiKey: string | undefined;
  if (info.requiresApiKey) {
    if (options.store === undefined) {
      throw missingCredentialError(providerId, info.apiKeyEnvVars);
    }
    const resolved = await resolveApiKey({
      providerId,
      ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
      conventionalEnvVars: info.apiKeyEnvVars,
      store: options.store,
    }).catch((error: unknown) => {
      throw new AuthError(`Could not look up an API key for “${providerId}”.`, {
        hint: 'Check that the credential store is reachable.',
        ...(error instanceof Error ? { cause: error } : {}),
      });
    });
    if (resolved === undefined) {
      throw missingCredentialError(providerId, info.apiKeyEnvVars);
    }
    apiKey = resolved.value;
  }

  const context: ProviderContext = {
    config,
    apiKey,
    baseUrl,
    appConfig: options.config,
    log,
  };

  const adapter = adapterFor(builtIn ?? config);

  let provider: Provider;
  switch (adapter) {
    case 'anthropic':
      provider = new AnthropicProvider(context, { info });
      break;
    case 'google':
      provider = new GeminiProvider(context, { info });
      break;
    case 'ollama':
      provider = new OllamaProvider(context, { info });
      break;
    case 'openai-compatible':
      provider = new OpenAiCompatibleProvider(context, { info });
      break;
  }

  return { provider, baseUrl, config };
}

/** Produce the `ProviderInfo` a built-in or a custom config entry needs. */
export function toProviderInfo(
  providerId: string,
  builtIn: BuiltInProvider | undefined,
  config: ProviderConfig,
): ProviderInfo {
  const defaults = builtIn;
  const name = defaults?.name ?? providerId;
  const apiKeyEnvVars =
    defaults?.apiKeyEnvVars ?? (config.apiKeyEnv === undefined ? [] : [config.apiKeyEnv]);
  return {
    id: providerId,
    name,
    defaultBaseUrl: defaults?.defaultBaseUrl ?? '',
    apiKeyEnvVars,
    requiresApiKey: defaults?.requiresApiKey ?? apiKeyEnvVars.length > 0,
    ...(defaults?.docsUrl === undefined ? {} : { docsUrl: defaults.docsUrl }),
    ...(defaults?.termsUrl === undefined ? {} : { termsUrl: defaults.termsUrl }),
  };
}

/** Resolve the base URL: a configured one wins, else the built-in default. */
function resolveBaseUrl(config: ProviderConfig, builtIn: BuiltInProvider | undefined): string {
  if (config.baseUrl !== undefined && config.baseUrl !== '') return config.baseUrl;
  if (builtIn !== undefined && builtIn.defaultBaseUrl !== '') return builtIn.defaultBaseUrl;
  throw new ConfigError('No base URL configured for this provider.', {
    hint: 'Set “baseUrl” in the provider config, or add it as a built-in.',
  });
}
