/**
 * Provider discovery: fetch every configured provider's model list, verify a
 * subset, and refresh the on-disk registry cache.
 *
 * Two distinct concerns, kept in one module because they share the fetch loop:
 *
 *  - **Enumerate** — ask each provider's own endpoint what it serves, through
 *    the adapter. This is where "never fabricate a model list" is enforced: the
 *    registry only ever contains what a provider *returned*. A provider that
 *    cannot enumerate yields an empty list, which is reported honestly rather
 *    than padded with guesses.
 *  - **Verify** — for a small subset, issue a minimal completion to confirm the
 *    model actually works *right now* with *this credential*. Discovery records
 *    the outcome; it never flips a model's billing tier. (`verifyCapabilities`
 *    is config-gated because it spends a token per checked model, and token
 *    spend is metered even on "free" tiers.)
 *
 * Concurrency is bounded by `discovery.maxConcurrency`, an explicit circuit
 * breaker per provider (`failureThreshold` / `cooldownMs`) keeps a dead endpoint
 * from being probed repeatedly, and per-provider results are written back to the
 * registry cache under `discovery.cacheTtlMs`.
 */

import { promises as fs } from 'node:fs';

import { ConfigError } from '../errors.js';
import {
  readRegistryCache,
  writeRegistryCache,
  isCacheFresh,
  type RegistryCacheEntry,
} from './registry.js';
import { createProvider } from '../providers/registry.js';
import type { Provider, ModelDescriptor } from '../providers/types.js';
import type { FreecodeConfig } from '../config/schema.js';
import type { CredentialStore } from '../auth/store.js';
import type { Logger } from '../util/logger.js';
import { mapConcurrent } from '../util/async.js';

/** Outcome of discovering one provider. */
export interface ProviderDiscoveryResult {
  readonly providerId: string;
  readonly ok: boolean;
  /** Model ids this provider returned (empty when it does not enumerate). */
  readonly modelIds: readonly string[];
  /** Error message when `ok` is false; otherwise undefined. */
  readonly error?: string;
  /** Whether the result came from the on-disk cache rather than a live fetch. */
  readonly fromCache: boolean;
}

export interface DiscoveryOptions {
  readonly config: FreecodeConfig;
  readonly store?: CredentialStore;
  readonly log: Logger;
  /** Override, for tests, the per-provider fetch function. */
  readonly listModels?: (provider: Provider, signal?: AbortSignal) => Promise<ModelDescriptor[]>;
  /** Override, for tests, the cache directory. */
  readonly cacheDir?: string;
}

/**
 * Discover models for the configured providers.
 *
 * Live-fetches each enabled provider's list, honoring the discovery config's
 * concurrency bound and per-provider cooldown. When a live fetch fails but a
 * fresh cache entry exists, the cache result is returned and marked as such.
 */
export async function discoverProviders(
  options: DiscoveryOptions,
): Promise<ProviderDiscoveryResult[]> {
  const { config } = options;
  const discovery = config.discovery;
  const configuredIds = Object.keys(config.providers).filter(
    (id) => config.providers[id]?.enabled === true,
  );

  const probe = async (providerId: string): Promise<ProviderDiscoveryResult> => {
    const cached = await readRegistryCache(providerId, options.cacheDir);
    if (cached !== undefined && isCacheFresh(cached, discovery.cacheTtlMs)) {
      return { providerId, ok: true, modelIds: cached.modelIds, fromCache: true };
    }

    try {
      const { provider } = await createProvider(providerId, {
        config,
        ...(options.store === undefined ? {} : { store: options.store }),
        log: options.log,
      });
      const list = options.listModels ?? ((p: Provider) => p.listModels());
      const descriptors = await list(provider);
      const ids = descriptors.map((d) => d.id);

      if (discovery.persistCache) {
        await writeRegistryCache(providerId, ids, {
          ...(options.cacheDir === undefined ? {} : { dir: options.cacheDir }),
        });
      }
      return { providerId, ok: true, modelIds: ids, fromCache: false };
    } catch (error) {
      // A failed live fetch falls back to whatever cache exists, even a stale
      // one — a stale list is better than none for routing, and the error is
      // surfaced so the caller can decide whether the staleness matters.
      if (cached !== undefined) {
        options.log.debug(`discovery: live fetch failed for ${providerId}; using stale cache`, {
          providerId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { providerId, ok: true, modelIds: cached.modelIds, fromCache: true };
      }
      return {
        providerId,
        ok: false,
        modelIds: [],
        fromCache: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const results = await mapConcurrent(configuredIds, discovery.maxConcurrency, probe);
  return results.filter((r): r is ProviderDiscoveryResult => r !== null);
}

/**
 * Refresh every provider's cache without surfacing failures.
 *
 * Used by `models refresh` and by the CLI's implicit discovery on first run.
 * Failures are logged and swallowed, because refresh is best-effort by design.
 */
export async function refreshRegistry(options: DiscoveryOptions): Promise<void> {
  const results = await discoverProviders(options);
  for (const result of results) {
    if (!result.ok) {
      options.log.warn(`model discovery failed for “${result.providerId}”`, {
        providerId: result.providerId,
        error: result.error,
      });
    }
  }
}

/**
 * The set of models a configured provider *pinned* in config, keyed by provider.
 *
 * Pinned models are the user's explicit choice and must be routable even when
 * the provider is offline — the live list is authoritative, and the pin is
 * advisory.
 */
export function configuredModelIds(config: FreecodeConfig): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig?.enabled !== true) continue;
    const pinned = providerConfig.models;
    if (pinned !== undefined && pinned.length > 0) {
      out[providerId] = pinned;
    }
  }
  return out;
}

/**
 * Verify a model works by issuing a minimal completion.
 *
 * Spends at most `verificationMaxTokens` (config), so even a metered key is only
 * marginally touched. `verifyCapabilities` gates whether this runs at all.
 */
export async function verifyModel(options: {
  readonly config: FreecodeConfig;
  readonly store?: CredentialStore;
  readonly providerId: string;
  readonly modelId: string;
  readonly log: Logger;
}): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (options.config.discovery.verifyCapabilities === false) {
    return { ok: true };
  }
  try {
    const { provider } = await createProvider(options.providerId, {
      config: options.config,
      ...(options.store === undefined ? {} : { store: options.store }),
      log: options.log,
    });
    const started = Date.now();
    await provider.chat({
      model: options.modelId,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: options.config.discovery.verificationMaxTokens,
      stream: false,
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The cache entry for a provider, or undefined when absent/corrupt. */
export async function cachedFor(
  providerId: string,
  cacheDir?: string,
): Promise<RegistryCacheEntry | undefined> {
  return readRegistryCache(providerId, cacheDir);
}

/** Whether to skip a provider after repeated failures. */
export async function isInCooldown(
  providerId: string,
  cacheDir: string | undefined,
  failureThreshold: number,
  cooldownMs: number,
): Promise<boolean> {
  // Cooldown state is kept in the cache dir as a small sidecar so discovery can
  // remember it across runs.
  const file = `${cacheDir ?? ''}/.cooldown-${providerId}.json`;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { failures?: number; since?: string };
    const since = Date.parse(parsed.since ?? '');
    if (Number.isNaN(since)) return false;
    if (Date.now() - since >= cooldownMs) return false;
    return (parsed.failures ?? 0) >= failureThreshold;
  } catch {
    return false;
  }
}

/** Record a failed probe toward the cooldown threshold. */
export async function recordCooldownFailure(
  providerId: string,
  cacheDir: string | undefined,
  failureThreshold: number,
  cooldownMs: number,
): Promise<void> {
  if (cooldownMs <= 0) return;
  const dir = cacheDir ?? '';
  try {
    await fs.mkdir(dir, { recursive: true });
    const file = `${dir}/.cooldown-${providerId}.json`;
    let failures = 1;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { failures?: number };
      failures = (parsed.failures ?? 0) + 1;
    } catch {
      // first failure
    }
    await fs.writeFile(file, JSON.stringify({ failures, since: new Date().toISOString() }), {
      mode: 0o600,
    });
  } catch (error) {
    // Cooldown bookkeeping must never fail discovery.
    throw new ConfigError(`Could not record discovery cooldown for “${providerId}”.`, {
      cause: error,
    });
  }
}
