/**
 * The models the gateway is willing to serve.
 *
 * The gateway is not a transparent proxy: it serves exactly the models its
 * operators configured, in the two shapes the CLI understands — a `provider/model`
 * reference and the provider's own bare id. Everything else is `404`, with a
 * message naming the model, because silently forwarding an unknown id upstream
 * is how a deployment ends up paying for a model nobody chose.
 *
 * Billing provenance follows the same rule as the rest of the project: it is
 * *recorded* from the configured provider, and `unknown` is treated as not-free.
 * Two refinements matter here:
 *
 *  - A keyless upstream (a self-hosted Ollama, or any entry with no
 *    `apiKeyEnv`) cannot cost money at the vendor, so an `unknown` billing is
 *    resolved to `free` rather than gating it out. This mirrors the same
 *    deferral the routing engine performs.
 *  - A `byok` or `free-tier` entry whose upstream key the gateway actually holds
 *    is, from the *caller's* perspective, a paid service of the gateway's — the
 *    gateway's operator is the one paying the vendor. So when
 *    `GATEWAY_ALLOW_PAID_MODELS` is off, those are gated too. The switch exists
 *    precisely so an operator can say "yes, this deployment may spend".
 */

import type { FreecodeConfig, ProviderConfig } from '@freecode/core';

export type BillingTier = 'free' | 'free-tier' | 'byok' | 'paid' | 'unknown';

export interface CatalogueEntry {
  /** `provider/model`, the reference the CLI sends when it has been told one. */
  readonly reference: string;
  /** The provider's own model id, for a caller that sends a bare id. */
  readonly model: string;
  readonly providerId: string;
  readonly billing: BillingTier;
  /** A per-million-token price, when the operator supplied one. */
  readonly pricing?: { readonly inputPer1M: number; readonly outputPer1M: number };
}

export interface Catalogue {
  readonly entries: readonly CatalogueEntry[];
  /** Resolve either a `provider/model` reference or a bare id. */
  resolve(idOrReference: string): CatalogueEntry | undefined;
  /** The entry served when a request omits `model`. */
  readonly defaultEntry: CatalogueEntry | undefined;
}

/**
 * Effective billing for a configured provider.
 *
 * A keyless upstream is free by construction; an `unknown` billing on a keyed
 * upstream stays `unknown`, which the gate treats as not-free.
 */
export function effectiveBilling(config: ProviderConfig): BillingTier {
  const declared = config.billing;
  const keyless = config.apiKeyEnv === undefined || config.apiKeyEnv === '';
  if (declared === 'unknown' && keyless) return 'free';
  return declared;
}

export interface BuildCatalogueOptions {
  readonly config: FreecodeConfig;
  /** Price table from `GATEWAY_PRICING`, keyed by model id. */
  readonly pricing: Readonly<Record<string, { inputPer1M: number; outputPer1M: number }>>;
  /** Model served when a request omits one. */
  readonly defaultModel: string;
  readonly defaultProvider: string;
}

export function buildCatalogue(options: BuildCatalogueOptions): Catalogue {
  const entries: CatalogueEntry[] = [];

  for (const [providerId, provider] of Object.entries(options.config.providers)) {
    if (provider.enabled === false) continue;
    const billing = effectiveBilling(provider);
    for (const model of provider.models) {
      const price = options.pricing[model] ?? options.pricing[`${providerId}/${model}`];
      entries.push({
        reference: `${providerId}/${model}`,
        model,
        providerId,
        billing,
        ...(price === undefined ? {} : { pricing: price }),
      });
    }
  }

  const byReference = new Map<string, CatalogueEntry>();
  const byBareModel = new Map<string, CatalogueEntry[]>();
  for (const entry of entries) {
    byReference.set(entry.reference, entry);
    const list = byBareModel.get(entry.model);
    if (list === undefined) byBareModel.set(entry.model, [entry]);
    else list.push(entry);
  }

  const defaultEntry = pickDefault(entries, options.defaultModel, options.defaultProvider);

  return {
    entries,
    defaultEntry,
    resolve(idOrReference: string): CatalogueEntry | undefined {
      const exact = byReference.get(idOrReference);
      if (exact !== undefined) return exact;

      const bare = byBareModel.get(idOrReference);
      if (bare === undefined) return undefined;
      // A bare id served by more than one upstream is genuinely ambiguous; the
      // caller must be told which, so resolution picks the configured default
      // provider's entry when there is one and otherwise refuses rather than
      // guessing. Refusing is the correct outcome: two upstreams may bill
      // differently, and silently choosing changes what the caller pays.
      if (bare.length === 1) return bare[0];
      const preferred = bare.find((entry) => entry.providerId === options.defaultProvider);
      return preferred;
    },
  };
}

function pickDefault(
  entries: readonly CatalogueEntry[],
  defaultModel: string,
  defaultProvider: string,
): CatalogueEntry | undefined {
  if (defaultModel !== '') {
    const byRef = entries.find((entry) => entry.reference === defaultModel);
    if (byRef !== undefined) return byRef;
    const byBare = entries.find((entry) => entry.model === defaultModel);
    if (byBare !== undefined) return byBare;
  }
  if (defaultProvider !== '') {
    const first = entries.find((entry) => entry.providerId === defaultProvider);
    if (first !== undefined) return first;
  }
  return entries[0];
}
