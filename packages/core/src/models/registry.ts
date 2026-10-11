/**
 * The local model registry cache.
 *
 * Discovery is *policy*: which providers to look at, at what concurrency, with
 * what verification. This file is the *state*: the models a provider enumerated,
 * written to disk so a cold start does not re-probe every provider. It is a
 * cache, not a source of truth — a provider's own endpoint remains authoritative
 * and the registry cache can always be regenerated (hence it lives under
 * `cacheHome()/registry`, not under user data).
 *
 * Layout: one JSON file per provider id under `registryCacheDir()`:
 *
 *   `<cacheDir>/<providerId>.json` →
 *   {
 *     "providerId": "groq",
 *     "fetchedAt": "2026-10-09T…Z",
 *     "modelIds": ["llama-3.3-70b-versatile", …]
 *   }
 *
 * Only *ids* are cached. Capability fields are the discovery probe's record and
 * are kept out of the cache file because they go stale fastest and are the
 * cheapest thing to re-verify; the registry can always re-fetch. Storing ids on
 * disk is still a privacy decision worth stating: the model list of a provider
 * the user configured is not a secret, so the cache is plain JSON with a
 * provider-scoped filename rather than a single file that mixes every provider.
 *
 * Security:
 *
 *  - Writes are atomic (temp file + rename) and mode 0600.
 *  - The cache is never trusted as a truth source: it is only used to seed the
 *    registry, and a provider whose cache entry is corrupt is treated as "no
 *    cache" rather than as a failure.
 *  - No credentials ever enter the cache. A provider's key is resolved by the
 *    factory and held in the adapter; the registry stores only model ids.
 *  - The cache directory is `cacheHome()/registry`, which the environment can
 *    redirect for tests via `FREECODE_CACHE_DIR`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../errors.js';
import { registryCacheDir } from '../config/paths.js';

/** Shape of a provider's registry-cache entry. */
export interface RegistryCacheEntry {
  readonly providerId: string;
  /** ISO-8601 timestamp of the fetch that produced this entry. */
  readonly fetchedAt: string;
  /** Model ids the provider serves, in the provider's own namespace. */
  readonly modelIds: readonly string[];
}

/** What a caller asks the registry for. */
export interface ModelRegistryQuery {
  /** Limit to a provider id. */
  readonly providerId?: string;
  /** Only models whose id contains this substring, case-insensitive. */
  readonly search?: string;
}

/** A resolved row of the registry, ready to route on. */
export interface RegistryRow {
  readonly providerId: string;
  readonly modelId: string;
  /** The full `provider/model` reference used by the CLI. */
  readonly reference: string;
  /** Source of the row: live fetch, provider cache, or config. */
  readonly source: 'live' | 'cache' | 'config';
}

/**
 * Read a provider's cache entry, tolerating a missing or corrupt file.
 *
 * Returns `undefined` for both "never cached" and "cached but unreadable" — the
 * registry treats a corrupt cache as an absence, never as an error, because the
 * cache must not be able to fail the whole discovery.
 */
export async function readRegistryCache(
  providerId: string,
  dir: string = registryCacheDir(),
): Promise<RegistryCacheEntry | undefined> {
  const file = path.join(dir, `${providerId}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Partial<RegistryCacheEntry>;
    if (
      typeof record.providerId !== 'string' ||
      record.providerId === '' ||
      typeof record.fetchedAt !== 'string' ||
      !Array.isArray(record.modelIds) ||
      record.modelIds.some((id) => typeof id !== 'string' || id === '')
    ) {
      return undefined;
    }
    if (record.providerId !== providerId) return undefined;
    return {
      providerId: record.providerId,
      fetchedAt: record.fetchedAt,
      modelIds: record.modelIds,
    };
  } catch {
    return undefined;
  }
}

export interface WriteRegistryCacheOptions {
  /** Directory to write under. Defaults to `registryCacheDir()`. */
  readonly dir?: string;
}

/**
 * Cache a provider's model list.
 *
 * Shares the atomic-write discipline of the credential store: write a temp file
 * in the same directory, `chmod` it 0600, then rename over the target. A reader
 * can never observe a half-written entry.
 */
export async function writeRegistryCache(
  providerId: string,
  modelIds: readonly string[],
  options: WriteRegistryCacheOptions = {},
): Promise<void> {
  const dir = options.dir ?? registryCacheDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${providerId}.json`);
  const tmp = path.join(dir, `.${providerId}.${process.pid}.${Date.now()}.tmp`);
  const payload: RegistryCacheEntry = {
    providerId,
    fetchedAt: new Date().toISOString(),
    modelIds,
  };

  try {
    await fs.writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (error) {
    // A failed cache write is not a reason to fail the registry or the command
    // that queried it. The user can always regenerate; the error is surfaced at
    // debug level, never shown as a failure.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new ConfigError(`Could not write the registry cache for “${providerId}”.`, {
      details: { providerId, dir },
      cause: error,
    });
  }
}

/** Whether a cache entry is still fresh under the configured TTL. */
export function isCacheFresh(
  entry: RegistryCacheEntry,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  const fetched = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetched)) return false;
  return now - fetched <= ttlMs;
}

/**
 * Build a queryable registry from configured providers, their live lists, and
 * their caches.
 *
 * `liveModels` maps provider id → the ids that provider's endpoint returned
 * (whether from a live fetch or from the cache). `configuredFor` adds any
 * explicit `providers.<id>.models` entries the user pinned, even when the
 * provider could not be reached — a pinned model is a deliberate routing choice
 * and must survive an offline moment.
 */
export function buildRegistry(options: {
  readonly liveModels: Readonly<Record<string, readonly string[]>>;
  /** Configured provider ids that should appear even when offline. */
  readonly configuredFor?: Readonly<Record<string, readonly string[]>>;
}): RegistryRow[] {
  const rows: RegistryRow[] = [];
  const seen = new Set<string>();

  const add = (providerId: string, modelId: string, source: RegistryRow['source']) => {
    const reference = `${providerId}/${modelId}`;
    if (seen.has(reference)) return;
    seen.add(reference);
    rows.push({ providerId, modelId, reference, source });
  };

  for (const [providerId, ids] of Object.entries(options.liveModels)) {
    for (const modelId of ids) add(providerId, modelId, 'live');
  }
  for (const [providerId, ids] of Object.entries(options.configuredFor ?? {})) {
    for (const modelId of ids) {
      // A configured model that also came from a live list keeps the live source;
      // the 'config' source only reappears when the model is purely pinned.
      add(providerId, modelId, 'config');
    }
  }

  return rows.sort((a, b) => a.reference.localeCompare(b.reference));
}

/** Query a registry, filtering by provider and search substring. */
export function queryRegistry(
  rows: readonly RegistryRow[],
  query: ModelRegistryQuery = {},
): RegistryRow[] {
  let result: readonly RegistryRow[] = rows;
  if (query.providerId !== undefined && query.providerId !== '') {
    result = result.filter((r) => r.providerId === query.providerId);
  }
  if (query.search !== undefined && query.search !== '') {
    const needle = query.search.toLowerCase();
    result = result.filter(
      (r) => r.modelId.toLowerCase().includes(needle) || r.reference.toLowerCase().includes(needle),
    );
  }
  return [...result];
}

/**
 * The union of every model this build knows about, live or cached.
 *
 * Convenience wrapper used by `models list` and the router: gather all cache
 * entries, merge with any config-pinned models, and return rows.
 */
export async function unionRegistry(options: {
  readonly cacheDir?: string;
  readonly ttlMs?: number;
  readonly configuredFor?: Readonly<Record<string, readonly string[]>>;
}): Promise<RegistryRow[]> {
  const dir = options.cacheDir ?? registryCacheDir();
  const live: Record<string, string[]> = {};
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const providerId = name.slice(0, -'.json'.length);
      const cached = await readRegistryCache(providerId, dir);
      if (cached === undefined) continue;
      if (options.ttlMs !== undefined && !isCacheFresh(cached, options.ttlMs)) continue;
      live[providerId] = [...cached.modelIds];
    }
  } catch {
    // A missing or unreadable cache dir is "no cache", not an error: every model
    // the user configured still shows up through `configuredFor`.
  }
  return buildRegistry({
    liveModels: live,
    ...(options.configuredFor === undefined ? {} : { configuredFor: options.configuredFor }),
  });
}
