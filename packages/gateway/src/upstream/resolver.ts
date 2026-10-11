/**
 * Builds and caches the `Provider` instances the gateway serves from.
 *
 * The gateway does not reimplement any provider protocol: it composes the same
 * adapters the CLI uses (`createProvider`), so an upstream that works in BYOK
 * works here, unchanged, including the SSRF guard, the redirect handling and the
 * response-size caps baked into `HttpClient`.
 *
 * **Where upstream keys come from.** From the environment, named by each
 * provider's `apiKeyEnv` (or the adapter's conventional variable). They are read
 * at construction, held by the adapter, and never logged — the `EnvCredentialStore`
 * below exists so `createProvider` has a store to consult, and it deliberately
 * returns values *only* from the environment, never from disk. A gateway that
 * read the operator's `~/.config/freecode/credentials.json` would be a
 * privilege-escalation path from a shared server to a personal machine.
 *
 * **Failure is per-provider.** One upstream with a bad key must not prevent the
 * others from serving, so `warm()` logs each failure and keeps the successes.
 * A request for a provider that could not be built gets a clear 502 naming it,
 * never a confusing downstream error.
 */

import {
  BUILT_IN_PROVIDERS,
  createProvider as coreCreateProvider,
  withDefaults,
  type CredentialStore,
  type FreecodeConfig,
  type Logger,
  type Provider,
  type ProviderConfig,
} from '@freecode/core';

/**
 * A credential store backed entirely by environment variables.
 *
 * `get(providerId)` reads the variable named by that provider's `apiKeyEnv`,
 * falling back to the adapter's conventional variable. `set`/`delete` are
 * refused: a gateway must not write secrets into a process it does not own the
 * lifecycle of, and the environment is the deployment's contract.
 */
export class EnvCredentialStore implements CredentialStore {
  readonly backend = 'file' as const;
  readonly secure = false;
  readonly #providers: Readonly<Record<string, ProviderConfig>>;
  readonly #env: NodeJS.ProcessEnv;

  constructor(providers: Readonly<Record<string, ProviderConfig>>, env: NodeJS.ProcessEnv) {
    this.#providers = providers;
    this.#env = env;
  }

  describe(): string {
    return 'environment variables (gateway)';
  }

  get(providerId: string): Promise<string | undefined> {
    const name = this.#envVarFor(providerId);
    if (name === undefined) return Promise.resolve(undefined);
    const value = this.#env[name];
    return Promise.resolve(value !== undefined && value.trim() !== '' ? value : undefined);
  }

  set(): Promise<void> {
    return Promise.reject(new Error('The gateway credential store is read-only.'));
  }

  delete(): Promise<boolean> {
    return Promise.resolve(false);
  }

  list(): Promise<string[]> {
    const ids: string[] = [];
    for (const providerId of Object.keys(this.#providers)) {
      if (this.#envVarFor(providerId) !== undefined) ids.push(providerId);
    }
    return Promise.resolve(ids);
  }

  /** The environment variable that holds this provider's key, if any. */
  #envVarFor(providerId: string): string | undefined {
    const configured = this.#providers[providerId]?.apiKeyEnv;
    if (configured !== undefined && configured !== '') return configured;
    const builtIn = BUILT_IN_PROVIDERS.find((p) => p.id === providerId);
    return builtIn?.apiKeyEnvVars[0];
  }
}

export interface ProviderResolverOptions {
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly log: Logger;
  /** Injected by tests; defaults to the real factory. */
  readonly createProviderFn?: typeof coreCreateProvider;
  readonly store?: CredentialStore;
}

export class ProviderResolver {
  readonly #appConfig: FreecodeConfig;
  readonly #log: Logger;
  readonly #create: typeof coreCreateProvider;
  readonly #store: CredentialStore;
  readonly #cache = new Map<string, Provider>();
  /** Provider ids that failed to build, so a repeat request is not retried. */
  readonly #failed = new Map<string, string>();

  constructor(options: ProviderResolverOptions) {
    this.#appConfig = withDefaults({ providers: options.providers });
    this.#log = options.log;
    this.#create = options.createProviderFn ?? coreCreateProvider;
    this.#store = options.store ?? new EnvCredentialStore(options.providers, process.env);
  }

  /** The full config the adapters receive, for diagnostics and tests. */
  get appConfig(): FreecodeConfig {
    return this.#appConfig;
  }

  /**
   * Get (building on first use) the provider for an id.
   *
   * Throws when the provider is unknown, disabled, or could not be constructed —
   * the caller maps that onto a 502 with the provider id in the message.
   */
  async get(providerId: string): Promise<Provider> {
    const cached = this.#cache.get(providerId);
    if (cached !== undefined) return cached;

    const failure = this.#failed.get(providerId);
    if (failure !== undefined) throw new Error(failure);

    try {
      const { provider } = await this.#create(providerId, {
        config: this.#appConfig,
        store: this.#store,
        log: this.#log.child({ component: 'upstream', providerId }),
      });
      this.#cache.set(providerId, provider);
      return provider;
    } catch (error) {
      // The message is safe to surface: `createProvider` never puts a key into
      // it, and the CLI redacts before display in any case.
      const message = error instanceof Error ? error.message : String(error);
      this.#failed.set(providerId, message);
      throw error;
    }
  }

  /** Build every configured provider, logging (not throwing on) failures. */
  async warm(): Promise<{ ready: string[]; failed: string[] }> {
    const ready: string[] = [];
    const failed: string[] = [];
    for (const providerId of Object.keys(this.#appConfig.providers)) {
      try {
        await this.get(providerId);
        ready.push(providerId);
      } catch (error) {
        failed.push(providerId);
        this.#log.warn('provider unavailable', {
          providerId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { ready, failed };
  }

  /** Drop cached instances (used when configuration changes at runtime). */
  clear(): void {
    this.#cache.clear();
    this.#failed.clear();
  }

  get size(): number {
    return this.#cache.size;
  }
}
