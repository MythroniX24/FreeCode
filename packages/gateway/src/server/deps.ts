/**
 * The dependencies a route handler needs, gathered into one object.
 *
 * Passing a single `RouteDeps` rather than five positional arguments keeps the
 * handler signatures readable and makes a test able to assemble a gateway out of
 * a memory store, a stub authenticator and a fake provider resolver without
 * touching the process environment.
 */

import type { Logger, StopReason } from '@freecode/core';

import type { GatewayConfig } from '../config.js';
import type { QuotaLimiter } from '../quota/limiter.js';
import type { UsageStore } from '../store/types.js';
import type { Catalogue, CatalogueEntry } from '../upstream/catalogue.js';
import type { ProviderResolver } from '../upstream/resolver.js';
import type { Authenticator } from './auth.js';

export interface RouteDeps {
  readonly startedAt: number;
  readonly config: GatewayConfig;
  readonly catalogue: Catalogue;
  readonly resolver: ProviderResolver;
  readonly authenticator: Authenticator;
  readonly limiter: QuotaLimiter;
  readonly store: UsageStore;
  readonly log: Logger;
}

/** Normalize a core stop reason onto the OpenAI `finish_reason` vocabulary. */
export function finishReasonOf(stopReason: StopReason): string {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'error':
    case 'unknown':
    default:
      // An unrecognised or failed completion is presented as a normal stop; the
      // client has already received whatever content arrived.
      return 'stop';
  }
}

/** Price a completed request, or `0` when the model has no operator-set price. */
export function costOf(entry: CatalogueEntry, inputTokens: number, outputTokens: number): number {
  if (entry.pricing === undefined) return 0;
  const inputCost = (inputTokens / 1_000_000) * entry.pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * entry.pricing.outputPer1M;
  // Rounded to six decimals to match `numeric(12,6)` in the schema, so the value
  // stored is the value summed.
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
