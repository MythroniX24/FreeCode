/**
 * Usage persistence, behind one interface.
 *
 * Two implementations exist and they are interchangeable:
 *
 *  - `MemoryUsageStore` — no dependencies, used for local development, for the
 *    test suite, and whenever `GATEWAY_DATABASE_URL` is unset. It is honest
 *    about the trade-off: state is lost on restart and is not shared between
 *    processes, so it is *not* a production store for more than one replica.
 *  - `PostgresUsageStore` — the production store. One `INSERT` per served
 *    request, and the quota windows are computed with a single aggregate query
 *    under a compound index.
 *
 * Recording is deliberately **append-only and after the fact**: a request is
 * written once it has finished, with the token counts the provider reported. The
 * gateway never writes a "reserved" row and then corrects it, because that would
 * make the accounting depend on a second write succeeding. The cost is that the
 * in-flight request is not yet counted; the concurrency limiter, not the ledger,
 * is what bounds simultaneous load.
 *
 * A request whose usage the provider did not report is recorded with zero
 * tokens — *not* with an estimate. Fabricating a count corrupts every downstream
 * total, which is precisely the failure this ledger exists to prevent; the cost
 * is that a provider which under-reports usage under-counts here, which is the
 * safe direction to be wrong in.
 */

export interface UsageRecordInput {
  readonly principalId: string;
  readonly model: string;
  readonly providerId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Computed from the price table, or `0` when the model has no price entry. */
  readonly costUsd: number;
  readonly latencyMs: number;
  /** HTTP status the client received (`200`, `499` on client disconnect, …). */
  readonly status: number;
  /** Epoch milliseconds. Defaults to now; injectable for deterministic tests. */
  readonly at?: number;
}

export interface UsageRecord {
  readonly id: string;
  readonly at: number;
  readonly principalId: string;
  readonly model: string;
  readonly providerId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly status: number;
}

export interface UsageAggregate {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export const EMPTY_AGGREGATE: UsageAggregate = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};

export interface UsageStore {
  readonly kind: 'memory' | 'postgres';
  /** Establish the connection / verify the schema. Called once at boot. */
  ready(): Promise<void>;
  close(): Promise<void>;
  /** Append one served request. */
  record(entry: UsageRecordInput): Promise<void>;
  /** Everything a principal has used since `sinceMs` (epoch ms). */
  summarize(principalId: string, sinceMs: number): Promise<UsageAggregate>;
  /** Spend across every principal since `sinceMs`. */
  totalCostSince(sinceMs: number): Promise<number>;
  /** The most recent served requests for a principal, newest first. */
  recent(principalId: string, limit: number): Promise<UsageRecord[]>;
}
