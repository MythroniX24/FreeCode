/**
 * Postgres-backed usage store.
 *
 * The schema is created by `migrations/001_usage.sql`, which an operator applies
 * (`npm run migrate`) before starting the gateway. This module never creates
 * tables itself: an application that silently issues DDL at boot is one that
 * will eventually do so with the wrong role, at the wrong time, against the
 * wrong database.
 *
 * Sizing and safety decisions:
 *
 *  - The token columns are `bigint`. A single busy day can exceed the 32-bit
 *    range when many users share a deployment, and an overflow there would wrap
 *    to a negative — turning a quota breach into negative usage, which is the
 *    worst possible failure for this table.
 *  - Every window query is served by `(principal_id, at DESC)`. A summary is one
 *    index scan, not a table scan.
 *  - All values are sent as bound parameters. Nothing here is string-built.
 */

import { Pool, type PoolClient } from 'pg';

import {
  EMPTY_AGGREGATE,
  type UsageAggregate,
  type UsageRecord,
  type UsageRecordInput,
  type UsageStore,
} from './types.js';

export interface PostgresUsageStoreOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
}

/** Shape of a `SUM`/`COUNT` row as `pg` returns it. */
interface AggregateRow {
  readonly requests: string | number | null;
  readonly input_tokens: string | number | null;
  readonly output_tokens: string | number | null;
  readonly cost_usd: string | number | null;
}

interface UsageRow {
  readonly id: string;
  readonly at: Date | string;
  readonly principal_id: string;
  readonly model: string;
  readonly provider_id: string;
  readonly input_tokens: string | number;
  readonly output_tokens: string | number;
  readonly cost_usd: string | number;
  readonly latency_ms: number;
  readonly status: number;
}

export class PostgresUsageStore implements UsageStore {
  readonly kind = 'postgres' as const;
  readonly #pool: Pool;

  constructor(options: PostgresUsageStoreOptions) {
    this.#pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      statement_timeout: options.statementTimeoutMs ?? 5_000,
      // A short connect timeout so a wrong host fails at boot, not at the first
      // user request.
      connectionTimeoutMillis: 5_000,
    });
    // `pg` emits `error` on an idle client whose backend died; without a
    // listener that is an unhandled event and would take the process down.
    this.#pool.on('error', () => undefined);
  }

  /** Verify the schema exists and is reachable, failing loudly at boot. */
  async ready(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      // A missing table is the common misconfiguration (migrations not applied);
      // querying it here turns a runtime 500 into a startup error.
      await client.query('SELECT 1 FROM usage_records LIMIT 1');
    } catch (error) {
      throw new Error(
        'The usage_records table is missing or unreachable. Apply migrations/001_usage.sql first.',
        { cause: error },
      );
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async record(entry: UsageRecordInput): Promise<void> {
    await this.#pool.query(
      `INSERT INTO usage_records
         (principal_id, model, provider_id, input_tokens, output_tokens, cost_usd, latency_ms, status, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))`,
      [
        entry.principalId,
        entry.model,
        entry.providerId,
        entry.inputTokens,
        entry.outputTokens,
        entry.costUsd,
        entry.latencyMs,
        entry.status,
        entry.at ?? Date.now(),
      ],
    );
  }

  async summarize(principalId: string, sinceMs: number): Promise<UsageAggregate> {
    const { rows } = await this.#pool.query<AggregateRow>(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_usd), 0)      AS cost_usd
         FROM usage_records
        WHERE principal_id = $1 AND at >= to_timestamp($2 / 1000.0)`,
      [principalId, sinceMs],
    );
    const row = rows[0];
    if (row === undefined) return EMPTY_AGGREGATE;
    return {
      requests: toNumber(row.requests),
      inputTokens: toNumber(row.input_tokens),
      outputTokens: toNumber(row.output_tokens),
      costUsd: toNumber(row.cost_usd),
    };
  }

  async totalCostSince(sinceMs: number): Promise<number> {
    const { rows } = await this.#pool.query<{ total: string | number | null }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM usage_records
        WHERE at >= to_timestamp($1 / 1000.0)`,
      [sinceMs],
    );
    return toNumber(rows[0]?.total ?? null);
  }

  async recent(principalId: string, limit: number): Promise<UsageRecord[]> {
    const { rows } = await this.#pool.query<UsageRow>(
      `SELECT id, at, principal_id, model, provider_id,
              input_tokens, output_tokens, cost_usd, latency_ms, status
         FROM usage_records
        WHERE principal_id = $1
        ORDER BY at DESC
        LIMIT $2`,
      [principalId, limit],
    );
    return rows.map((row) => ({
      id: String(row.id),
      at: toEpochMs(row.at),
      principalId: row.principal_id,
      model: row.model,
      providerId: row.provider_id,
      inputTokens: toNumber(row.input_tokens),
      outputTokens: toNumber(row.output_tokens),
      costUsd: toNumber(row.cost_usd),
      latencyMs: Number(row.latency_ms),
      status: Number(row.status),
    }));
  }

  /** Exposed for the health check, which reports pool saturation. */
  get pool(): Pool {
    return this.#pool;
  }

  /** Run a callback inside a transaction. Used only by tests and tooling. */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
}

/** `pg` returns `bigint` and `numeric` as strings to avoid precision loss. */
function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toEpochMs(value: Date | string): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
