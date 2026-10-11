/**
 * Routing and stealth discovery.
 *
 * The router's rules are few and worth pinning down exactly:
 *
 *  - **Never silently switch to paid.** A candidate billed `paid`/`unknown` is
 *    only routable when the user explicitly named it (a pin) or when
 *    `quota.allowPaidModels` is true. The paid-*fallback* gate is stricter still:
 *    landing on paid after a failed free attempt requires `allowPaidFallback`, a
 *    second switch the user flips knowingly.
 *  - **Pins win.** A user-named candidate outranks everything.
 *  - **Unmeasurable dimensions are neutral.** context/tools/coding score 0.5 for
 *    registry rows (no descriptors yet), so they never decide a routing alone.
 *  - **One provider owns a bare id.** Identification reports nothing (or
 *    ambiguity) rather than a guess.
 *
 * The suite tests the pure ranking against an injected fact set, the async
 * policy layer (`pickRoute`) with a stub store, and both degrees of stealth
 * identification.
 */

import { describe, expect, it } from 'vitest';

import { withDefaults } from '../src/config/schema.js';
import type { FreecodeConfig } from '../src/config/schema.js';
import type { RegistryRow } from '../src/models/registry.js';
import type { CredentialStore } from '../src/auth/store.js';
import { nullLogger } from '../src/util/logger.js';
import {
  buildFallbackChain,
  credentialAvailable,
  identifyModel,
  pickRoute,
  providerFromCatalogue,
  scoreCandidates,
  type CandidateFacts,
  type RouterWeights,
} from '../src/index.js';

const LOG = nullLogger();

const WEIGHTS: RouterWeights = {
  codingSuitability: 3,
  contextFit: 2,
  toolSupport: 2.5,
  reliability: 2,
  latency: 1,
  preference: 1.5,
};

/** A registry row, short-arm. */
function row(
  providerId: string,
  modelId: string,
  source: RegistryRow['source'] = 'config',
): RegistryRow {
  return { providerId, modelId, reference: `${providerId}/${modelId}`, source };
}

/** Facts for a single candidate, short-arm. */
function facts(
  billing: CandidateFacts['billing'],
  overrides: Partial<CandidateFacts> = {},
): CandidateFacts {
  return { billing, source: 'config', ...overrides };
}

function factsFor(
  rows: readonly RegistryRow[],
  overrides: Record<string, CandidateFacts> = {},
): Record<string, CandidateFacts> {
  const out: Record<string, CandidateFacts> = {};
  for (const r of rows) out[r.reference] = facts('free');
  for (const [ref, override] of Object.entries(overrides))
    out[ref] = { ...facts('free'), ...override };
  return out;
}

function withDefaultsConfig(partial: Record<string, unknown>): FreecodeConfig {
  return withDefaults(partial);
}

/** A provider entry that requires a key; its env var presence is all that matters. */
function keyedProvider(enabled = true): Record<string, unknown> {
  return { enabled, type: 'openai-compatible', apiKeyEnv: 'TEST_API_KEY', billing: 'free-tier' };
}

function keyFreeProvider(billing: string, enabled = true): Record<string, unknown> {
  return { enabled, type: 'ollama', billing };
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreCandidates — pure ranking
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreCandidates', () => {
  it('ranks free and free-tier candidates ahead of byok when preferFree is on', () => {
    const rows = [row('free', 'a'), row('byok', 'b'), row('free-tier', 'c')];
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows, { 'byok/b': facts('byok'), 'free-tier/c': facts('free-tier') }),
    });
    // free/c and free/a both beat byok/b; free-tier still scores above byok.
    const byokIndex = ranked.findIndex((c) => c.reference === 'byok/b');
    expect(byokIndex).toBeGreaterThan(-1);
    for (const ref of ['free/a', 'free-tier/c']) {
      expect(ranked.findIndex((c) => c.reference === ref)).toBeLessThan(byokIndex);
    }
  });

  it('drops a candidate the user pinned nowhere but whose billing is paid, with allowPaidModels off', () => {
    const rows = [row('p', 'm'), row('q', 'n')];
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows, { 'p/m': facts('paid'), 'q/n': facts('free') }),
    });
    expect(ranked.map((c) => c.reference)).toEqual(['q/n']);
  });

  it('keeps a paid candidate when it is explicitly pinned', () => {
    const rows = [row('p', 'm')];
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows, { 'p/m': facts('paid', { pinnedReference: true }) }),
    });
    expect(ranked[0]!.reference).toBe('p/m');
    expect(ranked[0]!.pinned).toBe(true);
  });

  it('keeps a paid candidate when allowPaidModels is true', () => {
    const rows = [row('p', 'm')];
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: true,
      facts: factsFor(rows, { 'p/m': facts('paid') }),
    });
    expect(ranked[0]!.reference).toBe('p/m');
  });

  it('preferFree computes a normalised score in [0,1]', () => {
    const rows = [row('free', 'a'), row('free', 'b')];
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows),
    });
    for (const candidate of ranked) {
      expect(candidate.score).toBeGreaterThanOrEqual(0);
      expect(candidate.score).toBeLessThanOrEqual(1);
    }
  });

  it('treats unknown billing as not-free at the pure layer, unless pinned', () => {
    // The keyless unknown⇒free mapping lives in `effectiveBilling` at the
    // `pickRoute` layer (see the loopback test there). `scoreCandidates` sees
    // facts only, and its rule for `unknown` is "not free" — gated out when
    // allowPaidModels is off, kept when the user pinned it.
    const rows = [row('local', 'm'), row('other', 'n')];
    const gated = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows, { 'local/m': facts('unknown', { loopback: true }) }),
    });
    // The unknown-billing candidate is absent; the free `other/n` candidate survives.
    expect(gated.some((c) => c.reference === 'local/m')).toBe(false);
    expect(gated.some((c) => c.reference === 'other/n')).toBe(true);

    const pinned = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows, {
        'local/m': facts('unknown', { loopback: true, pinnedReference: true }),
      }),
    });
    expect(pinned.find((c) => c.reference === 'local/m')).toBeDefined();

    const allowed = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: true,
      facts: factsFor(rows, { 'local/m': facts('unknown', { loopback: true }) }),
    });
    expect(allowed.some((c) => c.reference === 'local/m')).toBe(true);
  });

  it('a missing credential candidate is inadmissible', () => {
    const rows = [row('p', 'm')];
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows, { 'p/m': facts('free', { credential: false }) }),
    });
    expect(ranked).toEqual([]);
  });

  it('a disabled provider is inadmissible', () => {
    const rows = [row('p', 'm')];
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows, { 'p/m': facts('free', { enabled: false }) }),
    });
    expect(ranked).toEqual([]);
  });
});

describe('buildFallbackChain', () => {
  const rows = [row('free', 'a'), row('free', 'b'), row('paid', 'c'), row('free', 'd')];

  it('bounds the chain by maxFallbacks', () => {
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: true,
      facts: factsFor(rows, { 'paid/c': facts('paid') }),
    });
    const chain = buildFallbackChain(ranked, { maxFallbacks: 2, allowPaidFallback: false });
    expect(chain.length).toBe(3);
    expect(chain[0]!.reference).toBe('free/a');
  });

  it('with maxFallbacks 0 returns only the primary', () => {
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: true,
      facts: factsFor(rows, { 'paid/c': facts('paid') }),
    });
    const chain = buildFallbackChain(ranked, { maxFallbacks: 0, allowPaidFallback: false });
    expect(chain.map((c) => c.reference)).toEqual(['free/a']);
  });

  it('never crosses into paid as a fallback unless allowPaidFallback is on', () => {
    const ranked = scoreCandidates(rows, {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: true,
      facts: factsFor(rows, { 'paid/c': facts('paid') }),
    });
    const closed = buildFallbackChain(ranked, { maxFallbacks: 4, allowPaidFallback: false });
    expect(closed.some((c) => c.billing === 'paid' || c.billing === 'unknown')).toBe(false);

    const open = buildFallbackChain(ranked, { maxFallbacks: 4, allowPaidFallback: true });
    expect(open.some((c) => c.billing === 'paid')).toBe(true);
  });

  it('with fallbackEnabled false returns only the primary even when others are free', () => {
    const ranked = scoreCandidates(rows.slice(0, 2), {
      weights: WEIGHTS,
      preferFree: true,
      allowPaidModels: false,
      facts: factsFor(rows.slice(0, 2)),
    });
    const chain = buildFallbackChain(ranked, { maxFallbacks: 2, allowPaidFallback: false }, false);
    expect(chain.map((c) => c.reference)).toEqual(['free/a']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// providerFromCatalogue / CATALOGUE_NAMESPACES
// ─────────────────────────────────────────────────────────────────────────────

describe('providerFromCatalogue', () => {
  it('maps documented model-id prefixes to providers', () => {
    expect(providerFromCatalogue('claude-sonnet-5')).toBe('anthropic');
    expect(providerFromCatalogue('gemini-2.5-pro')).toBe('google');
    expect(providerFromCatalogue('ai/gemini-2.5-pro-001')).toBe('google');
    expect(providerFromCatalogue('llama-3.3-70b-versatile')).toBe('groq');
    expect(providerFromCatalogue('whisper-large-v3')).toBe('groq');
    expect(providerFromCatalogue('qwen2.5-coder')).toBe('groq');
  });

  it('treats the namespace list as a documented contract, never a guess', () => {
    // Prefixes that are NOT documented yield undefined — a bare unknown id must
    // not be silently attached to a provider.
    expect(providerFromCatalogue('gpt-4o')).toBeUndefined();
    expect(providerFromCatalogue('deepseek-v3')).toBeUndefined();
    expect(providerFromCatalogue('')).toBeUndefined();
  });

  it('matches case-insensitively', () => {
    expect(providerFromCatalogue('CLAUDE-SONNET-5')).toBe('anthropic');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// identifyModel — stealth identification
// ─────────────────────────────────────────────────────────────────────────────

describe('identifyModel', () => {
  it('resolves a bare id via the registry when a single row owns it', () => {
    const config = withDefaultsConfig({
      providers: { groq: keyedProvider(), google: keyedProvider() },
    });
    const rows = [row('groq', 'llama-3.3-70b-versatile', 'cache')];
    const result = identifyModel('llama-3.3-70b-versatile', { config, rows });
    expect(result.basis).toBe('registry');
    expect(result.providerId).toBe('groq');
  });

  it('prefers a registry match over a configured pin', () => {
    const config = withDefaultsConfig({
      providers: {
        custom: { enabled: true, type: 'openai-compatible', models: ['claude-x'] },
      },
    });
    const rows = [row('anthropic', 'claude-x', 'live')];
    const result = identifyModel('claude-x', { config, rows });
    expect(result.basis).toBe('registry');
    expect(result.providerId).toBe('anthropic');
  });

  it('resolves via a single configured pin when there is no registry', () => {
    const config = withDefaultsConfig({
      providers: {
        mine: { enabled: true, type: 'openai-compatible', models: ['my-1'] },
      },
    });
    const result = identifyModel('my-1', { config });
    expect(result.basis).toBe('config');
    expect(result.providerId).toBe('mine');
  });

  it('reports ambiguity when two providers pin the same id', () => {
    const config = withDefaultsConfig({
      providers: {
        a: { enabled: true, type: 'openai-compatible', models: ['shared'] },
        b: { enabled: true, type: 'openai-compatible', models: ['shared'] },
      },
    });
    const result = identifyModel('shared', { config });
    expect(result.basis).toBeUndefined();
    expect(result.providerId).toBe('');
  });

  it('reports ambiguity when the registry serves the id from two providers', () => {
    const config = withDefaultsConfig({ providers: { a: keyedProvider(), b: keyedProvider() } });
    const rows = [row('a', 'same', 'cache'), row('b', 'same', 'cache')];
    const result = identifyModel('same', { config, rows });
    expect(result.basis).toBeUndefined();
  });

  it('falls back to the catalogue namespace only when that provider is configured', () => {
    const config = withDefaultsConfig({ providers: { anthropic: keyedProvider() } });
    expect(identifyModel('claude-opus-5', { config }).basis).toBe('namespace');
    expect(identifyModel('claude-opus-5', { config }).providerId).toBe('anthropic');
  });

  it('does not guess through the catalogue when the provider is absent', () => {
    const config = withDefaultsConfig({});
    expect(identifyModel('claude-opus-5', { config }).basis).toBeUndefined();
  });

  it('does not attach the catalogue prefix when the provider is disabled', () => {
    const config = withDefaultsConfig({ providers: { anthropic: keyedProvider(false) } });
    expect(identifyModel('claude-opus-5', { config }).basis).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// credentialAvailable — presence-only checks
// ─────────────────────────────────────────────────────────────────────────────

describe('credentialAvailable', () => {
  it('is true when the store lists the provider', async () => {
    const config = withDefaultsConfig({ providers: { groq: keyedProvider() } });
    const store: CredentialStore = {
      backend: 'file',
      secure: false,
      describe: () => 'test',
      async get() {
        return undefined;
      },
      async set() {},
      async delete() {
        return true;
      },
      async list() {
        return ['groq'];
      },
    };
    expect(await credentialAvailable({ config, providerId: 'groq', store })).toBe(true);
  });

  it('is true when the conventional env var is present', async () => {
    // No custom `apiKeyEnv` — the adapter's conventional `GROQ_API_KEY` applies.
    const config = withDefaultsConfig({
      providers: { groq: { enabled: true, type: 'openai-compatible' } },
    });
    expect(
      await credentialAvailable({
        config,
        providerId: 'groq',
        env: { GROQ_API_KEY: 'x' } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it('is false when a key is required and nothing is present', async () => {
    const config = withDefaultsConfig({ providers: { groq: keyedProvider() } });
    const store: CredentialStore = {
      backend: 'file',
      secure: false,
      describe: () => 'test',
      async get() {
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
    expect(
      await credentialAvailable({
        config,
        providerId: 'groq',
        store,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it('is true without any credential for a keyless provider', async () => {
    const config = withDefaultsConfig({ providers: { ollama: { enabled: true, type: 'ollama' } } });
    expect(
      await credentialAvailable({ config, providerId: 'ollama', env: {} as NodeJS.ProcessEnv }),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickRoute — policy layer
// ─────────────────────────────────────────────────────────────────────────────

describe('pickRoute', () => {
  const store = (listed: readonly string[] = []): CredentialStore => ({
    backend: 'file',
    secure: false,
    describe: () => 'test',
    async get() {
      return undefined;
    },
    async set() {},
    async delete() {
      return true;
    },
    async list() {
      return [...listed];
    },
  });

  it('routes to a configured credential-backed provider', async () => {
    const config = withDefaultsConfig({ providers: { groq: keyedProvider() } });
    const rows = [row('groq', 'llama-3.3-70b-versatile', 'cache')];
    const decision = await pickRoute({
      config,
      rows,
      log: LOG,
      store: store(['groq']),
      env: {},
    });
    expect(decision.chosen).toBeDefined();
    expect(decision.chosen!.reference).toBe('groq/llama-3.3-70b-versatile');
    expect(decision.chosen!.billing).toBe('free-tier');
  });

  it('does not route to a provider whose key is missing', async () => {
    const config = withDefaultsConfig({ providers: { groq: keyedProvider() } });
    const rows = [row('groq', 'llama-3.3-70b-versatile', 'cache')];
    const decision = await pickRoute({ config, rows, log: LOG, store: store([]), env: {} });
    expect(decision.chosen).toBeUndefined();
    expect(decision.emptyReason).toBeDefined();
  });

  it('drops a phantom row whose provider is not in config', async () => {
    const config = withDefaultsConfig({ providers: {} });
    const rows = [row('ghost', 'x', 'cache')];
    const decision = await pickRoute({ config, rows, log: LOG, env: {} });
    expect(decision.chosen).toBeUndefined();
  });

  it('an explicit provider narrows the candidate pool', async () => {
    const config = withDefaultsConfig({
      providers: { groq: keyedProvider(), google: keyedProvider() },
    });
    const rows = [row('groq', 'llama-a'), row('google', 'gemini-a')];
    const decision = await pickRoute({
      config,
      rows,
      log: LOG,
      store: store(['groq', 'google']),
      explicitProvider: 'groq',
      env: {},
    });
    expect(decision.chosen!.providerId).toBe('groq');
  });

  it('a defaultModel provider/model pin is trusted even without a registry row', async () => {
    const config = withDefaultsConfig({
      defaultModel: 'groq/llama-3.3-70b-versatile',
      providers: { groq: keyedProvider() },
    });
    const decision = await pickRoute({
      config,
      rows: [],
      log: LOG,
      store: store(['groq']),
      env: {},
    });
    expect(decision.chosen).toBeDefined();
    expect(decision.chosen!.reference).toBe('groq/llama-3.3-70b-versatile');
  });

  it('refuses to cross into a paid fallback unless allowPaidFallback is on', async () => {
    const config = withDefaultsConfig({
      routing: { allowPaidFallback: false },
      quota: { allowPaidModels: true },
      providers: { free: keyFreeProvider('free'), paid: keyFreeProvider('paid') },
    });
    const rows = [row('free', 'a'), row('paid', 'c')];
    const decision = await pickRoute({ config, rows, log: LOG, env: {} });
    expect(decision.chain.map((c) => c.reference)).not.toContain('paid/c');

    const open = await pickRoute({
      config: withDefaultsConfig({
        routing: { allowPaidFallback: true },
        quota: { allowPaidModels: true },
        providers: { free: keyFreeProvider('free'), paid: keyFreeProvider('paid') },
      }),
      rows,
      log: LOG,
      env: {},
    });
    expect(open.chain.some((c) => c.reference === 'paid/c')).toBe(true);
  });

  it('a loopback keyless provider scores highest on latency without a key', async () => {
    const config = withDefaultsConfig({
      providers: {
        ollama: { enabled: true, type: 'ollama', billing: 'unknown' },
      },
    });
    const rows = [row('ollama', 'local-llm', 'config')];
    const decision = await pickRoute({ config, rows, log: LOG, env: {} });
    expect(decision.chosen).toBeDefined();
    expect(decision.chosen!.providerId).toBe('ollama');
    expect(decision.chosen!.billing).toBe('free');
  });
});
