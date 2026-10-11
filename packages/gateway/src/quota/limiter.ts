/**
 * Server-enforced quota and concurrency.
 *
 * This is the piece that makes the hosted access mode different from BYOK: the
 * *server* — not a client that could be edited — decides how much a principal may
 * consume. Every limit is checked before a request reaches an upstream, and the
 * decision is recorded in the usage ledger after it finishes.
 *
 * The three windows and the concurrency gate, and why each exists:
 *
 *  - **Requests per minute** bounds burstiness. It is what stops one caller from
 *    consuming a shared free tier's whole per-minute allowance.
 *  - **Requests per day** bounds total volume.
 *  - **Tokens per day** bounds cost more honestly than request count: one large
 *    request can dwarf a hundred small ones.
 *  - **Concurrency** bounds simultaneous upstream connections, which is what a
 *    free tier actually rate-limits on and what the local config models with
 *    `maxConcurrentRequests`.
 *
 * **Check-then-act is deliberate here.** The token sums are read just before the
 * request starts and do not include the in-flight request's own tokens, which are
 * unknown until it finishes. Trusting a reservation instead would mean a second
 * write that can fail, leaving a phantom. The concurrency gate — which *is*
 * atomic, via `Semaphore` — is what prevents a stampede of concurrent requests
 * from all passing the token check at once, so the two mechanisms cover each
 * other's gap.
 *
 * The day window is a rolling 24 hours, not a midnight boundary, so a caller
 * cannot double their daily allowance by using 100% either side of midnight.
 */

import { QuotaError, Semaphore } from '@freecode/core';

import type { UsageStore } from '../store/types.js';

export interface QuotaLimits {
  readonly requestsPerMinute: number;
  readonly requestsPerDay: number;
  readonly inputTokensPerDay: number;
  readonly outputTokensPerDay: number;
  readonly maxConcurrentRequests: number;
}

export interface QuotaDecision {
  readonly allowed: boolean;
  /** A stable code for the client: `rate_limited`, `quota_exceeded`, … */
  readonly code?: string;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface QuotaLimiterOptions {
  readonly limits: QuotaLimits;
  readonly store: UsageStore;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export class QuotaLimiter {
  readonly #limits: QuotaLimits;
  readonly #store: UsageStore;
  readonly #now: () => number;
  readonly #gate: Semaphore;

  constructor(options: QuotaLimiterOptions) {
    this.#limits = options.limits;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#gate = new Semaphore(options.limits.maxConcurrentRequests);
  }

  /** Slots currently free, for the health endpoint. */
  get available(): number {
    return this.#gate.available;
  }

  get pending(): number {
    return this.#gate.pending;
  }

  /**
   * Check every window for a principal.
   *
   * Returns `{ allowed: true }` or a decision carrying the offending limit and
   * the numbers involved — a bare "429" is useless to a user trying to work out
   * whether they are rate-limited or out of budget.
   */
  async check(principalId: string): Promise<QuotaDecision> {
    const now = this.#now();

    const lastMinute = await this.#store.summarize(principalId, now - MINUTE_MS);
    if (lastMinute.requests >= this.#limits.requestsPerMinute) {
      return {
        allowed: false,
        code: 'rate_limited',
        message: `Rate limit reached: ${this.#limits.requestsPerMinute} requests per minute.`,
        details: { limit: this.#limits.requestsPerMinute, used: lastMinute.requests, window: '1m' },
      };
    }

    const lastDay = await this.#store.summarize(principalId, now - DAY_MS);
    if (lastDay.requests >= this.#limits.requestsPerDay) {
      return {
        allowed: false,
        code: 'quota_exceeded',
        message: `Daily request quota reached: ${this.#limits.requestsPerDay} per day.`,
        details: { limit: this.#limits.requestsPerDay, used: lastDay.requests, window: '24h' },
      };
    }
    if (lastDay.inputTokens >= this.#limits.inputTokensPerDay) {
      return {
        allowed: false,
        code: 'quota_exceeded',
        message: `Daily input-token quota reached: ${this.#limits.inputTokensPerDay}.`,
        details: {
          limit: this.#limits.inputTokensPerDay,
          used: lastDay.inputTokens,
          window: '24h',
        },
      };
    }
    if (lastDay.outputTokens >= this.#limits.outputTokensPerDay) {
      return {
        allowed: false,
        code: 'quota_exceeded',
        message: `Daily output-token quota reached: ${this.#limits.outputTokensPerDay}.`,
        details: {
          limit: this.#limits.outputTokensPerDay,
          used: lastDay.outputTokens,
          window: '24h',
        },
      };
    }

    return { allowed: true };
  }

  /**
   * Take a concurrency slot, resolving with an idempotent release function.
   *
   * The wait is bounded by `timeoutMs`: a caller that waits forever behind a
   * saturated gateway is worse served than one told, promptly, to try again.
   * Exceeding the bound is reported as a `QuotaError`, not an internal error.
   *
   * `run` below is the ergonomic wrapper for a function; `hold` exists separately
   * because a **streamed** response must hold its slot for the whole life of the
   * generator, which is not a function call the wrapper can span. Releasing the
   * slot at the first byte instead of the last would defeat the limit entirely,
   * and streaming is the common case.
   */
  async hold(options: { timeoutMs?: number } = {}): Promise<() => void> {
    const timeoutMs = options.timeoutMs ?? 130_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await this.#gate.acquire(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new QuotaError('Timed out waiting for an inference slot; the gateway is saturated.', {
          details: { waitedMs: timeoutMs, maxConcurrent: this.#limits.maxConcurrentRequests },
          hint: 'Retry shortly.',
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run `fn` while holding a concurrency slot. Always releases, including on throw. */
  async run<T>(fn: () => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    const release = await this.hold(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
