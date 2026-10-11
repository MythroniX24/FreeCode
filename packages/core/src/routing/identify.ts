/**
 * Stealth identification: map a bare model id back to its provider.
 *
 * "Stealth" is a promise about *certainty*, not about hiding: the function
 * returns `undefined` rather than a guess, and `identifyModel` reports "provider
 * not identified" instead of inventing one. Guesses propagate as misroutes —
 * a model sent to the wrong API 400s at best and, worse, could land on a metered
 * endpoint — so the rule is structural: an identification is only returned when
 * one of these is *true*, in order:
 *
 *   A. The known catalogue namespaces. A model prefix that is documented (see
 *      `CATALOGUE_NAMESPACES`) maps quietly to its provider. These prefixes are
 *      vendor-maintained id shapes (`claude-*` for Anthropic, `ai/*` for Gemini,
 *      `llama–*` for Groq, `google/` for Gemini via the registry) and are treated
 *      as *hints*: the match only stands when that provider is actually
 *      configured. A bare `gpt-4` is *not* guessed — OpenAI is not in the local
 *      catalogue, so there is no configured OpenAI provider to route to.
 *
 *   B. The registry. A row whose `modelId` matches the bare id — from the live/
 *      cached union or from config pins — identifies the provider with full
 *      certainty. This is the strongest source and always outranks a prefix hint.
 *
 *   C. One configured provider owns the id. When exactly one enabled provider
 *      pins the id (`providers.<id>.models`) or lists it in its cache, that
 *      provider is the identification. More than one match is a conflict and
 *      yields `undefined` — the user must write `provider/model`, because we
 *      cannot read their mind.
 *
 * No credential values are read here, and nothing touches the network: the
 * function is synchronous and pure.
 */

import type { FreecodeConfig } from '../config/schema.js';
import type { RegistryRow } from '../models/registry.js';

/** A documented model-id prefix ⇒ provider. Order matters: first match wins. */
export const CATALOGUE_NAMESPACES: ReadonlyArray<readonly [prefix: string, providerId: string]> = [
  // Google Gemini ids are formatted `models/gemini-*` (REST) or `gemini-*`; the
  // `ai/*` space is the paid Vertex/Gemini API ids. Only Gemini lives here.
  ['ai/', 'google'],
  ['gemini', 'google'],
  ['claude', 'anthropic'],
  // Groq serves Llama, Qwen, and Whisper checkpoints.
  ['llama', 'groq'],
  ['whisper', 'groq'],
  ['qwen', 'groq'],
];

/** `undefined` when no documented namespace matches a bare id. */
export function providerFromCatalogue(model: string): string | undefined {
  const lower = model.trim().toLowerCase();
  if (lower === '') return undefined;
  for (const [prefix, providerId] of CATALOGUE_NAMESPACES) {
    if (lower.startsWith(prefix.toLowerCase())) return providerId;
  }
  return undefined;
}

export interface IdentifyModelResult {
  readonly providerId: string;
  /** How the identification was reached. `undefined` when not identified. */
  readonly basis: 'namespace' | 'registry' | 'config' | undefined;
}

/**
 * Identify the provider for a bare model id, never guessing.
 *
 * See the header for the ordering and the `undefined` contract. `rows` is the
 * union registry (live + cache + config pins); when the caller has one, it makes
 * the strongest signals available. The CLI resolves `--provider` *before* this
 * function, so no preference parameter is needed here: a user who names a
 * provider with a bare model already has their answer.
 */
export function identifyModel(
  model: string,
  options: { readonly config: FreecodeConfig; readonly rows?: readonly RegistryRow[] },
): IdentifyModelResult {
  const trimmed = model.trim();

  // B then A: a registry match is *certain* and outranks a prefix hint, because
  // a provider may legitimately serve an id that looks like another's. Ambiguity
  // (the same id served by two providers) yields "not identified" — the user
  // must write `provider/model`.
  if (options.rows !== undefined) {
    const matches = options.rows.filter((row) => row.modelId === trimmed);
    if (matches.length === 1) {
      return { providerId: matches[0]!.providerId, basis: 'registry' };
    }
    if (matches.length > 1) {
      return { providerId: '', basis: undefined };
    }
  }

  const configured = enabledProvidersWithModel(options.config, trimmed);
  if (configured.length === 1) {
    return { providerId: configured[0]!, basis: 'config' };
  }
  if (configured.length > 1) {
    return { providerId: '', basis: undefined }; // ambiguous
  }

  const namespace = providerFromCatalogue(trimmed);
  if (namespace !== undefined) {
    const provider = options.config.providers[namespace];
    if (provider !== undefined && provider.enabled === true) {
      return { providerId: namespace, basis: 'namespace' };
    }
  }

  return { providerId: '', basis: undefined };
}

/** Enabled providers that pin `model` in their `providers.<id>.models` list. */
function enabledProvidersWithModel(config: FreecodeConfig, model: string): string[] {
  const providers: string[] = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (provider?.enabled !== true) continue;
    if (provider.models.includes(model)) providers.push(providerId);
  }
  return providers;
}
