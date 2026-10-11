/**
 * Gateway configuration, read from the environment.
 *
 * The gateway is a *separate deployment* from the CLI, so it does not read the
 * user's `~/.config/freecode/config.json`. Everything it needs comes from the
 * process environment: a container orchestrator sets these, and none of them is
 * a secret value — the secrets (upstream API keys, gateway API keys) live in
 * environment variables that are *named* here, never inlined into a config file
 * or an argument list.
 *
 * Two rules carried over from the CLI, restated because they are easy to break
 * in a server context:
 *
 *  - **Keys are named, not stored.** `GATEWAY_PROVIDERS` records which env var
 *    holds an upstream's key (`apiKeyEnv`); the value is read only when an
 *    adapter is constructed, is held in the adapter, and never logged.
 *  - **Bounded by construction.** Every numeric limit has a hard ceiling here as
 *    well as in the core schema, so a typo in `REQUESTS_PER_DAY` cannot disable
 *    the runaway protection the gateway exists to provide.
 *
 * The parse is deliberately hand-written rather than a single zod schema: env
 * vars are all strings, and the coercion plus the "which variable was wrong"
 * error message reads far better as explicit code than as a chain of
 * `.transform().default()` calls whose failure modes are hard to see.
 */

import {
  ConfigError,
  providerConfigSchema,
  type LogLevel,
  type ProviderConfig,
} from '@freecode/core';

/** Adapter types an upstream may use. `gateway`/`custom` would recurse. */
export const UPSTREAM_TYPES = ['openai-compatible', 'anthropic', 'google', 'ollama'] as const;
export type UpstreamType = (typeof UPSTREAM_TYPES)[number];

/** Per-million-token prices for one model, in USD. Operator-supplied. */
export interface Pricing {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
}

export interface QuotaLimits {
  readonly requestsPerMinute: number;
  readonly requestsPerDay: number;
  readonly inputTokensPerDay: number;
  readonly outputTokensPerDay: number;
  /** Concurrent in-flight inference requests across the whole gateway. */
  readonly maxConcurrentRequests: number;
}

export interface DatabaseConfig {
  /** When false, the in-memory store is used and nothing survives a restart. */
  readonly enabled: boolean;
  readonly connectionString: string;
  readonly maxConnections: number;
  readonly statementTimeoutMs: number;
}

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly logFormat: 'text' | 'json';
  readonly trustProxy: boolean;
  /** Maximum accepted request body, bytes. */
  readonly bodyLimitBytes: number;
  /** How long an upstream inference request may run, milliseconds. */
  readonly upstreamTimeoutMs: number;
  readonly database: DatabaseConfig;
  readonly quota: QuotaLimits;
  /**
   * Whether a model whose billing is `paid` or `unknown` may be served at all.
   * Default **false**: the gateway refuses to spend money it was not told to.
   */
  readonly enforcePaidModels: boolean;
  /** Model served when a request omits one. Empty means "first of the default provider". */
  readonly defaultModel: string;
  readonly defaultProvider: string;
  /** Gateway API keys (raw values, compared by hash at request time). */
  readonly apiKeys: readonly string[];
  /** Upstream provider configs, keyed by id. */
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  /** Optional price table, keyed by model id. Absent means cost is not metered. */
  readonly pricing: Readonly<Record<string, Pricing>>;
}

const LOG_LEVELS_SET = new Set<string>(['silent', 'error', 'warn', 'info', 'debug', 'trace']);

/** Read a variable, treating an empty/whitespace value as absent. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function intFrom(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`, {
      details: { name, value: raw, min, max },
    });
  }
  return value;
}

function boolFrom(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = read(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  throw new ConfigError(`${name} must be a boolean (true/false).`, {
    details: { name, value: raw },
  });
}

function logLevelFrom(env: NodeJS.ProcessEnv): LogLevel {
  const raw = read(env, 'GATEWAY_LOG_LEVEL') ?? 'info';
  if (!LOG_LEVELS_SET.has(raw)) {
    throw new ConfigError(`GATEWAY_LOG_LEVEL must be one of ${[...LOG_LEVELS_SET].join(', ')}.`, {
      details: { value: raw },
    });
  }
  return raw as LogLevel;
}

/** Split a comma-separated list, dropping blanks and duplicates. */
function listFrom(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '') seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Parse and validate `GATEWAY_PROVIDERS`.
 *
 * The value is a JSON object mapping provider id → a provider config of the same
 * shape the CLI uses, so an operator configures an upstream exactly as they
 * would a BYOK provider. Entries with `enabled: false`, or with a type the
 * gateway cannot adapt (`gateway`, `custom`), are dropped rather than rejected —
 * a disabled entry is a deliberate "not this one", not an error.
 */
function providersFrom(env: NodeJS.ProcessEnv): Record<string, ProviderConfig> {
  const raw = read(env, 'GATEWAY_PROVIDERS');
  if (raw === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError('GATEWAY_PROVIDERS is not valid JSON.', {
      cause,
      hint: 'It must be a JSON object mapping provider id to a provider config.',
    });
  }

  const result = providerConfigSchema.safeParse(parsed);
  // `providerConfigSchema` validates a single entry; the env value is a record.
  const record = zodRecordOfProviders(parsed);
  if (record === undefined) {
    throw new ConfigError('GATEWAY_PROVIDERS must be a JSON object of provider configs.', {
      details: { received: result.success ? 'object' : 'not an object' },
    });
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [id, entry] of Object.entries(record)) {
    const parsedEntry = providerConfigSchema.safeParse(entry);
    if (!parsedEntry.success) {
      const issue = parsedEntry.error.issues[0];
      throw new ConfigError(
        `GATEWAY_PROVIDERS entry “${id}” is invalid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'unknown error'}.`,
        { details: { id } },
      );
    }
    if (parsedEntry.data.enabled === false) continue;
    if (!(UPSTREAM_TYPES as readonly string[]).includes(parsedEntry.data.type)) {
      throw new ConfigError(
        `GATEWAY_PROVIDERS entry “${id}” has type “${parsedEntry.data.type}”, which the gateway cannot use as an upstream.`,
        { details: { id, type: parsedEntry.data.type, allowed: UPSTREAM_TYPES } },
      );
    }
    providers[id] = parsedEntry.data;
  }
  return providers;
}

/** Narrow an unknown to a plain object of unknown values. */
function zodRecordOfProviders(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Parse `GATEWAY_PRICING`: `{ "<model>": { "inputPer1M": n, "outputPer1M": n } }`. */
function pricingFrom(env: NodeJS.ProcessEnv): Record<string, Pricing> {
  const raw = read(env, 'GATEWAY_PRICING');
  if (raw === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError('GATEWAY_PRICING is not valid JSON.', { cause });
  }
  const record = zodRecordOfProviders(parsed);
  if (record === undefined) {
    throw new ConfigError('GATEWAY_PRICING must be a JSON object keyed by model id.');
  }

  const pricing: Record<string, Pricing> = {};
  for (const [model, entry] of Object.entries(record)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigError(`GATEWAY_PRICING entry “${model}” must be an object.`);
    }
    const row = entry as Record<string, unknown>;
    const input = row['inputPer1M'];
    const output = row['outputPer1M'];
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
      throw new ConfigError(`GATEWAY_PRICING entry “${model}”.inputPer1M must be a number ≥ 0.`);
    }
    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      throw new ConfigError(`GATEWAY_PRICING entry “${model}”.outputPer1M must be a number ≥ 0.`);
    }
    pricing[model] = { inputPer1M: input, outputPer1M: output };
  }
  return pricing;
}

/**
 * Build the gateway configuration from an environment.
 *
 * Throws `ConfigError` (exit code 3) on anything malformed, so a bad deployment
 * fails at boot with a message naming the offending variable — never at the
 * first request, and never silently.
 */
export function parseGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const apiKeys = listFrom(read(env, 'GATEWAY_API_KEYS'));
  const providers = providersFrom(env);

  const databaseUrl = read(env, 'GATEWAY_DATABASE_URL') ?? read(env, 'DATABASE_URL');
  const database: DatabaseConfig = {
    enabled: databaseUrl !== undefined && databaseUrl !== '',
    connectionString: databaseUrl ?? '',
    maxConnections: intFrom(env, 'GATEWAY_DB_POOL_MAX', 10, 1, 200),
    statementTimeoutMs: intFrom(env, 'GATEWAY_DB_STATEMENT_TIMEOUT_MS', 5_000, 100, 60_000),
  };

  const defaultProvider = read(env, 'GATEWAY_DEFAULT_PROVIDER') ?? Object.keys(providers)[0] ?? '';

  return {
    host: read(env, 'GATEWAY_HOST') ?? '127.0.0.1',
    port: intFrom(env, 'GATEWAY_PORT', 8787, 1, 65_535),
    logLevel: logLevelFrom(env),
    logFormat: read(env, 'GATEWAY_LOG_FORMAT') === 'json' ? 'json' : 'text',
    trustProxy: boolFrom(env, 'GATEWAY_TRUST_PROXY', false),
    bodyLimitBytes: intFrom(
      env,
      'GATEWAY_BODY_LIMIT_BYTES',
      4 * 1024 * 1024,
      1_024,
      64 * 1024 * 1024,
    ),
    upstreamTimeoutMs: intFrom(env, 'GATEWAY_UPSTREAM_TIMEOUT_MS', 120_000, 1_000, 600_000),
    database,
    quota: {
      requestsPerMinute: intFrom(env, 'GATEWAY_REQUESTS_PER_MINUTE', 60, 1, 10_000),
      requestsPerDay: intFrom(env, 'GATEWAY_REQUESTS_PER_DAY', 2_000, 1, 1_000_000),
      inputTokensPerDay: intFrom(env, 'GATEWAY_INPUT_TOKENS_PER_DAY', 2_000_000, 1, 1_000_000_000),
      outputTokensPerDay: intFrom(env, 'GATEWAY_OUTPUT_TOKENS_PER_DAY', 500_000, 1, 1_000_000_000),
      maxConcurrentRequests: intFrom(env, 'GATEWAY_MAX_CONCURRENT_REQUESTS', 4, 1, 64),
    },
    enforcePaidModels: boolFrom(env, 'GATEWAY_ALLOW_PAID_MODELS', false),
    defaultModel: read(env, 'GATEWAY_DEFAULT_MODEL') ?? '',
    defaultProvider,
    apiKeys,
    providers,
    pricing: pricingFrom(env),
  };
}
