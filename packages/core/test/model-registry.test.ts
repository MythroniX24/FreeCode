/**
 * Model registry cache + query tests.
 *
 * These run against a real temp directory (via `FREECODE_CACHE_DIR`), so the
 * atomic-write and corrupt-file handling are meaningful rather than mocked.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRegistry,
  isCacheFresh,
  queryRegistry,
  readRegistryCache,
  unionRegistry,
  writeRegistryCache,
} from '../src/models/registry.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freecode-registry-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// read / write cache
// ─────────────────────────────────────────────────────────────────────────────

describe('registry cache file', () => {
  it('round-trips a provider model list with 0600 perms', async () => {
    const dir = await tempDir();
    await writeRegistryCache('groq', ['llama-3.3-70b', 'mixtral-8x7b'], { dir });
    const entry = await readRegistryCache('groq', dir);
    expect(entry?.providerId).toBe('groq');
    expect(entry?.modelIds).toEqual(['llama-3.3-70b', 'mixtral-8x7b']);
    expect(Number.isNaN(Date.parse(entry?.fetchedAt ?? ''))).toBe(false);

    const file = path.join(dir, 'groq.json');
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    // No temp files left behind.
    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('treats a corrupt cache as absent, not as an error', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'groq.json'), 'not-json', { mode: 0o600 });
    expect(await readRegistryCache('groq', dir)).toBeUndefined();
  });

  it('treats a wrongly-scoped cache as absent', async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, 'groq.json'),
      JSON.stringify({
        providerId: 'anthropic',
        fetchedAt: new Date().toISOString(),
        modelIds: ['x'],
      }),
      { mode: 0o600 },
    );
    expect(await readRegistryCache('groq', dir)).toBeUndefined();
  });

  it('returns undefined for a provider that was never cached', async () => {
    const dir = await tempDir();
    expect(await readRegistryCache('anthropic', dir)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// freshness
// ─────────────────────────────────────────────────────────────────────────────

describe('isCacheFresh', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');

  it('is fresh within the TTL', () => {
    expect(
      isCacheFresh(
        { providerId: 'p', fetchedAt: new Date(now - 60_000).toISOString(), modelIds: [] },
        5 * 60_000,
        now,
      ),
    ).toBe(true);
  });

  it('is stale past the TTL', () => {
    expect(
      isCacheFresh(
        { providerId: 'p', fetchedAt: new Date(now - 600_000).toISOString(), modelIds: [] },
        5 * 60_000,
        now,
      ),
    ).toBe(false);
  });

  it('treats an unparseable timestamp as stale', () => {
    expect(
      isCacheFresh({ providerId: 'p', fetchedAt: 'not-a-time', modelIds: [] }, 60_000, now),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRegistry / queryRegistry / unionRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRegistry', () => {
  it('merges live lists and configured models, dedupes by reference', () => {
    const rows = buildRegistry({
      liveModels: { groq: ['a', 'b'], anthropic: ['a'] },
      configuredFor: { groq: ['b'], ollama: ['llama3'] },
    });
    expect(rows.map((r) => r.reference).sort()).toEqual([
      'anthropic/a',
      'groq/a',
      'groq/b',
      'ollama/llama3',
    ]);
    // The config-sourced duplicate of a live model keeps the live source.
    expect(rows.find((r) => r.reference === 'groq/b')?.source).toBe('live');
    expect(rows.find((r) => r.reference === 'ollama/llama3')?.source).toBe('config');
  });

  it('returns rows sorted by reference', () => {
    const rows = buildRegistry({ liveModels: { z: ['c'], a: ['b', 'a'] } });
    expect(rows.map((r) => r.reference)).toEqual(['a/a', 'a/b', 'z/c']);
  });
});

describe('queryRegistry', () => {
  const rows = buildRegistry({
    liveModels: { groq: ['llama-3.3-70b', 'mixtral-8x7b'], anthropic: ['claude-opus-4'] },
  });

  it('filters by provider', () => {
    const result = queryRegistry(rows, { providerId: 'groq' });
    expect(result.map((r) => r.modelId)).toEqual(['llama-3.3-70b', 'mixtral-8x7b']);
  });

  it('filters by substring case-insensitively', () => {
    const result = queryRegistry(rows, { search: 'LLAMA' });
    expect(result.map((r) => r.reference)).toEqual(['groq/llama-3.3-70b']);
  });

  it('returns everything with an empty query', () => {
    expect(queryRegistry(rows)).toEqual(rows);
  });
});

describe('unionRegistry', () => {
  it('reads every provider cache file', async () => {
    const dir = await tempDir();
    await writeRegistryCache('groq', ['a'], { dir });
    await writeRegistryCache('anthropic', ['b', 'c'], { dir });
    const rows = await unionRegistry({ cacheDir: dir });
    expect(rows.map((r) => r.reference).sort()).toEqual(['anthropic/b', 'anthropic/c', 'groq/a']);
  });

  it('excludes stale entries when a TTL is given', async () => {
    const dir = await tempDir();
    await writeRegistryCache('groq', ['a'], { dir });
    const rows = await unionRegistry({ cacheDir: dir, ttlMs: 1 });
    expect(rows).toEqual([]);
  });

  it('still surfaces configured models with no cache at all', async () => {
    const dir = await tempDir();
    const rows = await unionRegistry({ cacheDir: dir, configuredFor: { ollama: ['llama3'] } });
    expect(rows.map((r) => r.reference)).toEqual(['ollama/llama3']);
    expect(rows[0]?.source).toBe('config');
  });
});
