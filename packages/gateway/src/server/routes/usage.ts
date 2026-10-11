/**
 * `GET /v1/usage` — a principal's own consumption.
 *
 * Scoped to the authenticated principal, always: the endpoint takes no parameter
 * naming whose usage to return, so there is no way to phrase a request for
 * another account's numbers. The principal id is derived from the presented key
 * (see `auth.ts`), never sent by the client.
 *
 * This is a FreeCode extension, not part of the OpenAI surface — harmless there,
 * since an OpenAI client never calls it, and genuinely useful to a user trying
 * to understand why they are being rate-limited.
 */

import type { Principal } from '../auth.js';
import type { RouteDeps } from '../deps.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export interface UsageSummary {
  readonly principal: string;
  readonly window: '24h';
  readonly limits: {
    readonly requestsPerMinute: number;
    readonly requestsPerDay: number;
    readonly inputTokensPerDay: number;
    readonly outputTokensPerDay: number;
    readonly maxConcurrentRequests: number;
  };
  readonly used: {
    readonly lastHourRequests: number;
    readonly lastDayRequests: number;
    readonly lastDayInputTokens: number;
    readonly lastDayOutputTokens: number;
    readonly lastDayCostUsd: number;
  };
  readonly recent: readonly {
    readonly at: string;
    readonly model: string;
    readonly provider: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly latencyMs: number;
    readonly status: number;
  }[];
}

export async function handleUsage(
  deps: RouteDeps,
  principal: Principal,
  limit: number,
): Promise<{ status: number; body: UsageSummary }> {
  const now = Date.now();
  const [lastDay, lastHour, recent] = await Promise.all([
    deps.store.summarize(principal.id, now - DAY_MS),
    deps.store.summarize(principal.id, now - HOUR_MS),
    deps.store.recent(principal.id, limit),
  ]);

  return {
    status: 200,
    body: {
      principal: principal.id,
      window: '24h',
      limits: {
        requestsPerMinute: deps.config.quota.requestsPerMinute,
        requestsPerDay: deps.config.quota.requestsPerDay,
        inputTokensPerDay: deps.config.quota.inputTokensPerDay,
        outputTokensPerDay: deps.config.quota.outputTokensPerDay,
        maxConcurrentRequests: deps.config.quota.maxConcurrentRequests,
      },
      used: {
        lastHourRequests: lastHour.requests,
        lastDayRequests: lastDay.requests,
        lastDayInputTokens: lastDay.inputTokens,
        lastDayOutputTokens: lastDay.outputTokens,
        lastDayCostUsd: Math.round(lastDay.costUsd * 1_000_000) / 1_000_000,
      },
      recent: recent.map((record) => ({
        at: new Date(record.at).toISOString(),
        model: record.model,
        provider: record.providerId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costUsd: record.costUsd,
        latencyMs: record.latencyMs,
        status: record.status,
      })),
    },
  };
}
