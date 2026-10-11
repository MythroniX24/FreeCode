/**
 * In-process usage store.
 *
 * Correct and dependency-free, which is what makes it the right default for
 * development and for the test suite. It is explicitly *not* a production store:
 * state is lost when the process exits, and two replicas each keep their own
 * copy, so quotas would be enforced per-replica rather than per-account. The
 * module says so out loud (and `main.ts` logs a warning at boot) rather than
 * letting an operator discover it during an incident.
 *
 * The window queries scan the retained records. That is fine at the scale this
 * store is meant for; the Postgres store answers the same questions with an
 * indexed aggregate.
 */

import { randomUUID } from 'node:crypto';

import {
  EMPTY_AGGREGATE,
  type UsageAggregate,
  type UsageRecord,
  type UsageRecordInput,
  type UsageStore,
} from './types.js';

export interface MemoryUsageStoreOptions {
  /**
   * Hard cap on retained records. Old records are evicted first, so the cap
   * bounds memory at the cost of forgetting the oldest usage — acceptable
   * because a memory-store deployment is not one whose quota accuracy anyone
   * should depend on.
   */
  readonly maxRecords?: number;
  /** Injectable clock, so tests can advance time without sleeping. */
  readonly now?: () => number;
}

export class MemoryUsageStore implements UsageStore {
  readonly kind = 'memory' as const;
  readonly #records: UsageRecord[] = [];
  readonly #maxRecords: number;
  readonly #now: () => number;

  constructor(options: MemoryUsageStoreOptions = {}) {
    this.#maxRecords = options.maxRecords ?? 100_000;
    this.#now = options.now ?? Date.now;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#records.length = 0;
    return Promise.resolve();
  }

  record(entry: UsageRecordInput): Promise<void> {
    this.#records.push({
      id: randomUUID(),
      at: entry.at ?? this.#now(),
      principalId: entry.principalId,
      model: entry.model,
      providerId: entry.providerId,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
      latencyMs: entry.latencyMs,
      status: entry.status,
    });
    if (this.#records.length > this.#maxRecords) {
      this.#records.splice(0, this.#records.length - this.#maxRecords);
    }
    return Promise.resolve();
  }

  summarize(principalId: string, sinceMs: number): Promise<UsageAggregate> {
    return Promise.resolve(aggregate(this.#records, principalId, sinceMs));
  }

  totalCostSince(sinceMs: number): Promise<number> {
    let total = 0;
    for (const record of this.#records) {
      if (record.at >= sinceMs) total += record.costUsd;
    }
    return Promise.resolve(total);
  }

  recent(principalId: string, limit: number): Promise<UsageRecord[]> {
    const matching: UsageRecord[] = [];
    // Iterate newest-first so the limit stops early rather than filtering a
    // full copy of the array.
    for (let i = this.#records.length - 1; i >= 0 && matching.length < limit; i -= 1) {
      const record = this.#records[i];
      if (record !== undefined && record.principalId === principalId) matching.push(record);
    }
    return Promise.resolve(matching);
  }
}

function aggregate(
  records: readonly UsageRecord[],
  principalId: string,
  sinceMs: number,
): UsageAggregate {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const record of records) {
    if (record.principalId !== principalId || record.at < sinceMs) continue;
    requests += 1;
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    costUsd += record.costUsd;
  }
  if (requests === 0) return EMPTY_AGGREGATE;
  return { requests, inputTokens, outputTokens, costUsd };
}
