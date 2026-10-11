/**
 * The routing engine: choose the best `provider/model` for a request.
 *
 * Two layers, deliberately separated:
 *
 *  - **`scoreCandidates`** is pure and synchronous. Given registry rows and a
 *    fact for each row (billing tier, provenance, user pins, latency proxy), it
 *    produces a ranked list of `RouteCandidate`s. Nothing here touches the
 *    credential store, the environment, or the filesystem, so the ranking rules
 *    can be asserted test-by-test.
 *
 *  - **`pickRoute`** is the async entry the CLI calls. It resolves the facts
 *    (billing from config/built-in catalogue, credential availability from the
 *    store and environment *without ever reading a key value*, the latency proxy
 *    from the resolved base URL), applies the user's pins and the paid-admission
 *    rule, ranks, and returns the fallback chain the agent may fail over to.
 *
 * The rules that hold here, in one place:
 *
 *   A. **Never silently switch to paid.** A candidate whose billing is `paid` or
 *      `unknown` is routed only when the user explicitly named it (a reference,
 *      `--provider`, `defaultProvider`/`defaultModel`) or when
 *      `quota.allowPaidModels` is true. Automatic selection never crosses that
 *      line. The one deliberate exception: an endpoint that needs *no key* at
 *      all cannot bill the user, so `unknown` billing on a keyless provider is
 *      treated as free.
 *
 *   B. **Falls are bounded.** `routing.maxFallbacks` caps the chain, and a paid
 *      candidate is never *reached by failing over* unless `routing.allowPaidFallback`
 *      is true — reaching paid by accident (a free model 429ing, then silently
 *      landing on a metered one) is exactly the failure this rule exists for.
 *
 *   C. **Pins win.** A candidate the user named gets the `preference` factor at
 *      full weight; everything else ranks below it. `preferFree` then separates
 *      the unpinned remainder.
 *
 *   D. **Credential-available beats credential-missing.** A provider that needs
 *      a key and has none present is *inadmissible*, never merely degraded.
 *      There is no point ranking a model we cannot authenticate to.
 *
 *   E. **Unmeasurable dimensions are neutral.** The registry stores model ids
 *      only — no measured context window, latency, or coding fit. Those factors
 *      score a neutral 0.5 until a descriptor-carrying probe fills them; the
 *      weights remain meaningful for that future (and are configurable today),
 *      but a neutral factor never decides a routing by itself.
 */

import { builtInProvider, toProviderInfo } from '../providers/registry.js';
import type { CredentialStore } from '../auth/store.js';
import type { FreecodeConfig } from '../config/schema.js';
import type { RegistryRow } from '../models/registry.js';
import type { Logger } from '../util/logger.js';

/** Billing tier of a provider, as declared by the config or the catalogue. */
export type BillingTier = 'free' | 'free-tier' | 'byok' | 'paid' | 'unknown';

/**
 * Fixed weight of the free-preference factor, applied when `routing.preferFree`.
 * It lives outside `routing.weights` because the schema scopes those six weights
 * to the named dimensions; free preference is a router-level policy with its own
 * weight so "prefer free" still *loses* to an explicit user pin (preference's
 * factor is 1.0 vs 0.85 even for the best free tier).
 */
export const FREE_PREFERENCE_WEIGHT = 2;

/** The named score weights. Shape mirrors `routing.weights`. */
export interface RouterWeights {
  readonly codingSuitability: number;
  readonly contextFit: number;
  readonly toolSupport: number;
  readonly reliability: number;
  readonly latency: number;
  readonly preference: number;
}

/** The observable facts about one candidate that the score is computed from. */
export interface CandidateFacts {
  /** Effective billing tier (after the keyless-unknown ⇒ free mapping). */
  readonly billing: BillingTier;
  /** Provenance of the registry row. */
  readonly source: RegistryRow['source'];
  /** Exact `defaultModel` `provider/model` match, or `--model provider/model`. */
  readonly pinnedReference?: boolean;
  /** Bare `defaultModel` matches this row's model id. */
  readonly pinnedModel?: boolean;
  /** `--provider`/`defaultProvider` matches this row's provider id. */
  readonly pinnedProvider?: boolean;
  /** Whether this provider's base URL is literal loopback (near-zero latency). */
  readonly loopback?: boolean;
  /** Whether this provider can authenticate right now. */
  readonly credential?: boolean;
  /** Set when the provider is configured but disabled. */
  readonly enabled?: boolean;
}

/** A scored, admissible candidate ready to route on. */
export interface RouteCandidate {
  readonly providerId: string;
  readonly model: string;
  /** `provider/model` reference, as the CLI prints it. */
  readonly reference: string;
  readonly billing: BillingTier;
  readonly source: RegistryRow['source'];
  /** Whether the user explicitly named this candidate. */
  readonly pinned: boolean;
  /** Weighted score, normalised to [0, 1]. Higher is better. */
  readonly score: number;
  /** Per-dimension factor values, for `routing.explain`. */
  readonly features: ReadonlyArray<{ readonly dimension: string; readonly value: number }>;
}

/** The result of a routing decision. */
export interface RoutingDecision {
  /** The primary candidate. `undefined` when nothing is admissible. */
  readonly chosen: RouteCandidate | undefined;
  /**
   * Ordered candidates the agent may fail over to, bounded by
   * `maxFallbacks` and the paid-fallback rule.
   */
  readonly chain: readonly RouteCandidate[];
  /** Every admissible candidate, best-first (for `models which`/explaining). */
  readonly ranked: readonly RouteCandidate[];
  /** Why the chain is empty, when it is. Maps to a helpful CLI error. */
  readonly emptyReason?: string;
  /** Terminal-safe explanation lines, one per chain entry. */
  readonly explanation: readonly string[];
}

export interface PickRouteOptions {
  readonly config: FreecodeConfig;
  /** Candidate rows — normally the union of config pins and the registry cache. */
  readonly rows: readonly RegistryRow[];
  /** Provider rows are already filtered to configured+enabled providers. */
  readonly log: Logger;
  /** Credential store, for availability checks. Optional when no key is needed. */
  readonly store?: CredentialStore;
  /** Environment override, for tests. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** `--provider`: pin routing to this provider. */
  readonly explicitProvider?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admission
// ─────────────────────────────────────────────────────────────────────────────

function isPaidOrUnknown(billing: BillingTier): boolean {
  return billing === 'paid' || billing === 'unknown';
}

/** Whether a candidate passes the gates (paid rule, enabled, credential). */
function isAdmissible(facts: CandidateFacts, allowPaidModels: boolean): boolean {
  if (facts.enabled === false) return false;
  if (facts.credential === false) return false;
  const explicitlyChosen =
    facts.pinnedReference === true || facts.pinnedProvider === true || facts.pinnedModel === true;
  if (isPaidOrUnknown(facts.billing) && !allowPaidModels && !explicitlyChosen) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring factors
// ─────────────────────────────────────────────────────────────────────────────

function freeFactor(billing: BillingTier, preferFree: boolean): number {
  if (!preferFree) return 0.5;
  switch (billing) {
    case 'free':
      return 1;
    case 'free-tier':
      return 0.85;
    case 'byok':
      return 0.4;
    case 'unknown':
      return 0.25;
    case 'paid':
      return 0;
  }
}

function reliabilityFactor(source: RegistryRow['source']): number {
  switch (source) {
    case 'live':
      return 1;
    case 'cache':
      return 0.75;
    case 'config':
      return 0.5;
  }
}

function preferenceFactor(facts: CandidateFacts): number {
  if (facts.pinnedReference === true) return 1;
  if (facts.pinnedProvider === true || facts.pinnedModel === true) return 0.9;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure ranking
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreOptions {
  readonly weights: RouterWeights;
  readonly preferFree: boolean;
  readonly allowPaidModels: boolean;
  /** Facts per row, keyed by `row.reference`. */
  readonly facts: Readonly<Record<string, CandidateFacts>>;
}

/**
 * Rank admissible candidates by a weighted score over their facts.
 *
 * Pure: no I/O, deterministic. Every factor is in [0, 1]; the total weight is the
 * sum of the named weights plus `FREE_PREFERENCE_WEIGHT` when `preferFree` is on,
 * so the returned score is normalised to [0, 1] and dimensions compare fairly.
 */
export function scoreCandidates(
  rows: readonly RegistryRow[],
  options: ScoreOptions,
): RouteCandidate[] {
  const { weights, preferFree, allowPaidModels } = options;
  const candidates: RouteCandidate[] = [];
  for (const row of rows) {
    const facts = options.facts[row.reference];
    if (facts === undefined) continue;
    if (!isAdmissible(facts, allowPaidModels)) continue;

    const features = routeFeatures(facts, preferFree);
    const totalWeight =
      weights.codingSuitability +
      weights.contextFit +
      weights.toolSupport +
      weights.reliability +
      weights.latency +
      weights.preference +
      (preferFree ? FREE_PREFERENCE_WEIGHT : 0);
    const featured = sumFeatures(features, weights, preferFree);
    const score = totalWeight > 0 ? featured / totalWeight : 0.5;

    candidates.push({
      providerId: row.providerId,
      model: row.modelId,
      reference: row.reference,
      billing: facts.billing,
      source: row.source,
      pinned:
        facts.pinnedReference === true ||
        facts.pinnedProvider === true ||
        facts.pinnedModel === true,
      score,
      features,
    });
  }
  // Deterministic order: score desc, then reference asc.
  candidates.sort((a, b) => b.score - a.score || a.reference.localeCompare(b.reference));
  return candidates;
}

/** The six factor values, kept separately from the weighted sum for display. */
function routeFeatures(
  facts: CandidateFacts,
  preferFree: boolean,
): Array<{ readonly dimension: string; readonly value: number }> {
  return [
    // Dimensions awaiting measured capabilities are neutral (see header, rule E).
    { dimension: 'coding', value: 0.5 },
    { dimension: 'context', value: 0.5 },
    { dimension: 'tools', value: 0.5 },
    { dimension: 'reliability', value: reliabilityFactor(facts.source) },
    { dimension: 'latency', value: facts.loopback === true ? 1 : 0.5 },
    { dimension: 'preference', value: preferenceFactor(facts) },
    // Free preference participates in the sum only when enabled.
    ...(preferFree ? [{ dimension: 'free', value: freeFactor(facts.billing, true) }] : []),
  ];
}

function sumFeatures(
  features: ReadonlyArray<{ readonly dimension: string; readonly value: number }>,
  weights: RouterWeights,
  preferFree: boolean,
): number {
  let sum = 0;
  for (const feature of features) {
    const weight = weightOf(feature.dimension, weights, preferFree);
    sum += weight * feature.value;
  }
  return sum;
}

function weightOf(dimension: string, weights: RouterWeights, preferFree: boolean): number {
  switch (dimension) {
    case 'coding':
      return weights.codingSuitability;
    case 'context':
      return weights.contextFit;
    case 'tools':
      return weights.toolSupport;
    case 'reliability':
      return weights.reliability;
    case 'latency':
      return weights.latency;
    case 'preference':
      return weights.preference;
    case 'free':
      return preferFree ? FREE_PREFERENCE_WEIGHT : 0;
    default:
      return 0;
  }
}

/**
 * Build the ordered fallback chain from a ranked list.
 *
 * Bounded by `maxFallbacks` (0 disables fallback). A candidate whose billing is
 * paid/unknown is admitted as a fallback only when `allowPaidFallback` is true —
 * the primary is admitted by the admission rule above, but *landing* on paid via
 * a failed free attempt is a separate, stricter consent the user must switch on.
 */
export function buildFallbackChain(
  ranked: readonly RouteCandidate[],
  options: { readonly maxFallbacks: number; readonly allowPaidFallback: boolean },
  fallbackEnabled = true,
): RouteCandidate[] {
  if (!fallbackEnabled) {
    return ranked[0] === undefined ? [] : [ranked[0]]!;
  }
  const chain: RouteCandidate[] = [];
  for (const candidate of ranked) {
    if (chain.length >= options.maxFallbacks + 1) break;
    if (chain.length > 0 && isPaidOrUnknown(candidate.billing) && !options.allowPaidFallback) {
      continue;
    }
    chain.push(candidate);
  }
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// Async orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a provider can authenticate right now — without reading any key value.
 *
 * Checks, in order: env var *presence* for the provider's named and conventional
 * variables, then whether the store lists the provider. Values are never fetched
 * (`store.get`) and never returned: routing has no business holding a secret in
 * memory, and presence checks are enough to decide admissibility.
 */
export async function credentialAvailable(options: {
  readonly config: FreecodeConfig;
  readonly providerId: string;
  readonly store?: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const { config, providerId } = options;
  const provider = config.providers[providerId];
  if (provider === undefined || provider.enabled !== true) return false;
  const info = toProviderInfo(providerId, builtInProvider(providerId), provider);
  if (!info.requiresApiKey) return true;

  if (options.store !== undefined && (await options.store.list()).includes(providerId)) return true;

  const env = options.env ?? process.env;
  const names = [
    ...(provider.apiKeyEnv === undefined ? [] : [provider.apiKeyEnv]),
    ...info.apiKeyEnvVars,
  ];
  for (const name of new Set(names)) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return true;
  }
  return false;
}

/** Split a `provider/model` reference, or `undefined` for a bare model id. */
function splitReference(
  reference: string,
): { readonly providerId: string; readonly model: string } | undefined {
  const slash = reference.indexOf('/');
  if (slash <= 0) return undefined;
  return { providerId: reference.slice(0, slash), model: reference.slice(slash + 1) };
}

/**
 * Effective billing for a configured provider.
 *
 * An unset `billing` (`unknown` is the schema default) defers to the built-in
 * catalogue's documentation when the provider is a known one. And an endpoint
 * that needs *no key at all* — self-hosted, cannot bill the user — is `'free'`
 * even when its billing is `unknown`; routing must never gate a keyless local
 * model on an unknown-billing rule (header rule A).
 */
function effectiveBilling(config: FreecodeConfig, providerId: string): BillingTier {
  const provider = config.providers[providerId];
  if (provider === undefined) return 'unknown';
  const configured = provider.billing;
  let billing: BillingTier = configured;
  if (billing === 'unknown') {
    const builtIn = builtInProvider(providerId);
    if (builtIn !== undefined && builtIn.billing !== 'unknown') billing = builtIn.billing;
  }
  const requiresKey = toProviderInfo(
    providerId,
    builtInProvider(providerId),
    provider,
  ).requiresApiKey;
  if (billing === 'unknown' && !requiresKey) return 'free';
  return billing;
}

/** True when the provider's resolved base URL is literal loopback. */
function isLoopbackBaseUrl(config: FreecodeConfig, providerId: string): boolean {
  const provider = config.providers[providerId];
  if (provider === undefined) return false;
  const builtIn = builtInProvider(providerId);
  const raw =
    provider.baseUrl !== undefined && provider.baseUrl !== ''
      ? provider.baseUrl
      : builtIn?.defaultBaseUrl;
  if (raw === undefined || raw === '') return false;
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Route a request to the best admissible `provider/model`.
 *
 * The user's signals are resolved in this order, each narrowing the candidate
 * pool before scoring:
 *
 *   1. `explicitProvider` (`--provider`) — pins the provider.
 *   2. `config.defaultProvider` — pins the provider when no explicit one is given.
 *   3. `config.defaultModel` — `provider/model` pins an exact reference (trusted
 *      even before discovery); a bare id narrows to that model across providers.
 *
 * When nothing is admissible, `chosen` is `undefined` and `emptyReason` explains
 * which gate closed so the CLI can say something truthful rather than guess.
 */
export async function pickRoute(options: PickRouteOptions): Promise<RoutingDecision> {
  const { config, log, env } = options;
  const routing = config.routing;
  const weights = routing.weights as RouterWeights;
  const allowPaid = config.quota.allowPaidModels;

  const defaultRef = splitReference(config.defaultModel);
  const defaultBare = config.defaultModel !== '' && defaultRef === undefined;

  // Candidate pool: only configured, enabled providers. This also drops phantom
  // rows from a registry cache left behind by a provider later removed from config.
  let pool = options.rows.filter((row) => config.providers[row.providerId]?.enabled === true);

  // Credential availability is computed once per provider (one `store.list`).
  const credentialCache = new Map<string, Promise<boolean>>();
  const credential = (providerId: string): Promise<boolean> => {
    let entry = credentialCache.get(providerId);
    if (entry === undefined) {
      entry = credentialAvailable({
        config,
        providerId,
        ...(options.store === undefined ? {} : { store: options.store }),
        ...(env === undefined ? {} : { env }),
      });
      credentialCache.set(providerId, entry);
    }
    return entry;
  };

  const pinnedProviderId =
    options.explicitProvider !== undefined && options.explicitProvider !== ''
      ? options.explicitProvider
      : config.defaultProvider !== ''
        ? config.defaultProvider
        : undefined;

  if (pinnedProviderId !== undefined) {
    pool = pool.filter((row) => row.providerId === pinnedProviderId);
  }

  // defaultModel `provider/model`: an explicit pin that must survive pre-discovery.
  if (defaultRef !== undefined) {
    const provider = config.providers[defaultRef.providerId];
    if (provider !== undefined && provider.enabled === true) {
      const exists = pool.some(
        (row) => row.reference === defaultRef.providerId + '/' + defaultRef.model,
      );
      if (!exists) {
        // The user pinned it; trust it as a synthetic 'config' row even though
        // discovery has not yet confirmed it. The provider itself will validate.
        pool = [
          ...pool,
          {
            providerId: defaultRef.providerId,
            modelId: defaultRef.model,
            reference: `${defaultRef.providerId}/${defaultRef.model}`,
            source: 'config',
          },
        ];
      }
    }
  }
  if (defaultBare) {
    pool = pool.filter((row) => row.modelId === config.defaultModel);
  }

  // Resolve facts asynchronously, then rank purely.
  const facts: Record<string, CandidateFacts> = {};
  for (const row of pool) {
    const provider = config.providers[row.providerId];
    if (provider === undefined) continue;
    const billing = effectiveBilling(config, row.providerId);
    facts[row.reference] = {
      billing,
      source: row.source,
      loopback: isLoopbackBaseUrl(config, row.providerId),
      enabled: true,
      credential: await credential(row.providerId),
      ...(defaultRef !== undefined &&
      row.reference === `${defaultRef.providerId}/${defaultRef.model}`
        ? { pinnedReference: true }
        : {}),
      ...(defaultBare && row.modelId === config.defaultModel ? { pinnedModel: true } : {}),
      ...(pinnedProviderId === row.providerId ? { pinnedProvider: true } : {}),
    };
  }

  const ranked = scoreCandidates(pool, {
    weights,
    preferFree: routing.preferFree,
    allowPaidModels: allowPaid,
    facts,
  });
  const chain = buildFallbackChain(
    ranked,
    { maxFallbacks: routing.maxFallbacks, allowPaidFallback: routing.allowPaidFallback },
    routing.fallbackEnabled,
  );

  const chosen = chain[0];
  const explanation = buildExplanation(chain);
  const emptyReason =
    chosen === undefined
      ? describeEmpty(config, pool, pinnedProviderId, defaultRef, allowPaid, defaultBare)
      : undefined;
  log.debug('routing decided', {
    chosen: chosen?.reference,
    chain: chain.map((c) => c.reference),
    pool: pool.length,
  });
  return {
    chosen,
    chain,
    ranked,
    ...(emptyReason === undefined ? {} : { emptyReason }),
    explanation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Explanation
// ─────────────────────────────────────────────────────────────────────────────

function buildExplanation(chain: readonly RouteCandidate[]): readonly string[] {
  return chain.map((candidate, index) => {
    const features = candidate.features
      .map((f) => `${f.dimension}=${f.value.toFixed(2)}`)
      .join(' ');
    const pinned = candidate.pinned ? 'pinned ' : '';
    return `  ${index + 1}) ${candidate.reference}  score ${candidate.score.toFixed(3)}  ${pinned}[${candidate.billing} ${features}]`;
  });
}

/**
 * Explain an empty result truthfully. The message names the gate that closed:
 * only paid/unknown billing with the paid switch off, a defaultModel naming a
 * provider that is not enabled, a pin with no known models, or an empty pool.
 */
function describeEmpty(
  config: FreecodeConfig,
  pool: readonly RegistryRow[],
  pinnedProviderId: string | undefined,
  defaultRef: { readonly providerId: string; readonly model: string } | undefined,
  allowPaid: boolean,
  defaultBare: boolean,
): string {
  if (!allowPaid && pool.length > 0) {
    return (
      'The only known models are billed as paid or unknown, and ' +
      '“quota.allowPaidModels” is off. Set a “free”/“free-tier”/“byok” billing ' +
      'on the provider, or allow paid models explicitly.'
    );
  }
  if (defaultRef !== undefined) {
    const provider = config.providers[defaultRef.providerId];
    if (provider === undefined || provider.enabled !== true) {
      return `“defaultModel” names provider “${defaultRef.providerId}”, which is not configured or not enabled.`;
    }
    return `No model is reachable for “${defaultRef.providerId}/${defaultRef.model}”. The provider may need a credential or a models refresh.`;
  }
  if (defaultBare) {
    return `No provider is configured for the pinned model “${config.defaultModel}”.`;
  }
  if (pinnedProviderId !== undefined) {
    const provider = config.providers[pinnedProviderId];
    if (provider === undefined || provider.enabled !== true) {
      return `Provider “${pinnedProviderId}” is not configured or not enabled.`;
    }
    return `No model is known for provider “${pinnedProviderId}”. Run “freecode models refresh”, or pass --model explicitly.`;
  }
  return (
    'No models are available. Run “freecode models refresh” to discover models, ' +
    'pin some with “providers.<id>.models”, or set a defaultProvider in config.'
  );
}
