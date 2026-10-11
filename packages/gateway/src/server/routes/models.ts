/**
 * `GET /v1/models` and `GET /v1/models/:id`.
 *
 * The listing is the gateway's own catalogue, not a live upstream enumeration.
 * That is deliberate: the gateway serves exactly what its operator configured,
 * so advertising a model an upstream happens to have but the operator did not
 * enable would invite requests the gateway will then refuse.
 *
 * The `id` is the `provider/model` reference, which is what a client should send
 * back in `chat/completions`. A bare model id also resolves (see the catalogue),
 * but the canonical, unambiguous form is the reference.
 */

import { VERSION } from '@freecode/core';

import type { RouteDeps } from '../deps.js';
import { notFound } from '../errors.js';

export interface ModelListEntry {
  readonly id: string;
  readonly object: 'model';
  readonly created: number;
  readonly owned_by: string;
  /** FreeCode-specific provenance, ignored by generic OpenAI clients. */
  readonly freecode: {
    readonly model: string;
    readonly provider: string;
    readonly billing: string;
    readonly priced: boolean;
  };
}

export function handleModelsList(deps: RouteDeps): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      object: 'list',
      data: deps.catalogue.entries.map((entry) =>
        toModel(
          entry.reference,
          entry.model,
          entry.providerId,
          entry.billing,
          entry.pricing !== undefined,
        ),
      ),
    },
  };
}

export function handleModelRetrieve(
  deps: RouteDeps,
  id: string,
): { status: number; body: unknown } {
  const entry = deps.catalogue.resolve(id);
  if (entry === undefined) {
    throw notFound(`The gateway does not serve model “${id}”.`);
  }
  return {
    status: 200,
    body: toModel(
      entry.reference,
      entry.model,
      entry.providerId,
      entry.billing,
      entry.pricing !== undefined,
    ),
  };
}

function toModel(
  reference: string,
  model: string,
  providerId: string,
  billing: string,
  priced: boolean,
): ModelListEntry {
  return {
    id: reference,
    object: 'model',
    // The gateway has no per-model creation date. Zero is the honest value; a
    // fabricated `Date.now()` would imply a freshness that does not exist.
    created: 0,
    owned_by: providerId,
    freecode: { model, provider: providerId, billing, priced },
  };
}

/** `GET /health` — liveness plus a small, non-secret operational snapshot. */
export function handleHealth(deps: RouteDeps): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      store: deps.store.kind,
      authEnabled: deps.authenticator.enabled,
      paidModelsAllowed: deps.config.enforcePaidModels,
      models: deps.catalogue.entries.length,
      providers: [...new Set(deps.catalogue.entries.map((entry) => entry.providerId))].sort(),
      concurrency: { available: deps.limiter.available, pending: deps.limiter.pending },
    },
  };
}
