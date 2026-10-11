/**
 * Structured logger.
 *
 * Design decisions that matter for a CLI that pipes into other tools:
 *
 *   - **Logs go to stderr, never stdout.** stdout is reserved for the actual
 *     result (`--json` payloads, model lists, diffs) so `freecode models list
 *     --json | jq` is not corrupted by progress chatter.
 *   - **Everything is redacted on the way out**, at the single write point, rather
 *     than at each call site. A call site that forgets is a leak; a single choke
 *     point that cannot be forgotten is a guarantee. See `util/redact.ts`.
 *   - **Fields are redacted deeply**, so `log.info('req', { headers })` cannot leak
 *     an Authorization header.
 *   - **Sink is injectable** so tests can capture output without touching the
 *     process streams, and so the gateway can ship logs to a collector.
 */

import { redact, redactValue } from './redact.js';

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFormat = 'text' | 'json';

/** Numeric severity, used for level filtering. Higher is more verbose. */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export interface LogRecord {
  readonly level: Exclude<LogLevel, 'silent'>;
  /** ISO-8601 timestamp. */
  readonly time: string;
  /** Redacted human-readable message. */
  readonly msg: string;
  /** Redacted structured fields. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** Destination for rendered log lines. Injectable for tests and the gateway. */
export interface LogSink {
  write(line: string): void;
}

/** Writes to a stream (default: `process.stderr`). */
export function streamSink(stream: { write(chunk: string): unknown }): LogSink {
  return {
    write(line: string) {
      try {
        stream.write(line);
      } catch {
        // A closed stderr (broken pipe, detached process) must never crash the
        // CLI. Dropping the line is the correct behaviour here.
      }
    },
  };
}

/** Collects lines in memory. Intended for tests and for the gateway's buffers. */
export function memorySink(limit = 1000): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
      if (lines.length > limit) lines.shift();
    },
  };
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly format?: LogFormat;
  readonly sink?: LogSink;
  /** Extra fields merged into every record (e.g. `{ component: 'gateway' }`). */
  readonly bindings?: Readonly<Record<string, unknown>>;
  /** Stable per-process id, included so multi-process logs can be correlated. */
  readonly runId?: string;
}

export class Logger {
  readonly level: LogLevel;
  readonly format: LogFormat;
  readonly #sink: LogSink;
  readonly #bindings: Readonly<Record<string, unknown>>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.format = options.format ?? 'text';
    this.#sink = options.sink ?? streamSink(process.stderr);
    this.#bindings = options.bindings ?? {};
  }

  /** Derive a logger with additional bound context and/or overridden settings. */
  child(
    bindings: Readonly<Record<string, unknown>>,
    overrides: Omit<LoggerOptions, 'bindings'> = {},
  ): Logger {
    return new Logger({
      level: overrides.level ?? this.level,
      format: overrides.format ?? this.format,
      sink: overrides.sink ?? this.#sink,
      bindings: { ...this.#bindings, ...bindings },
    });
  }

  /** True when a record at `level` would be emitted. Lets callers avoid
   *  building expensive debug payloads that would be discarded. */
  isEnabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.level];
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.#emit('error', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.#emit('warn', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.#emit('info', msg, fields);
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.#emit('debug', msg, fields);
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    this.#emit('trace', msg, fields);
  }

  #emit(level: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>): void {
    if (!this.isEnabled(level)) return;

    const merged = fields === undefined ? this.#bindings : { ...this.#bindings, ...fields };

    // Redact before rendering. `redactValue` walks nested objects and replaces
    // values under sensitive-looking keys outright.
    const safeMsg = redact(msg);
    const safeFields = redactValue(merged);

    const record: LogRecord = {
      level,
      time: new Date().toISOString(),
      msg: safeMsg,
      ...(Object.keys(safeFields).length === 0 ? {} : { fields: safeFields }),
    };

    this.#sink.write(this.format === 'json' ? `${JSON.stringify(record)}\n` : renderText(record));
  }
}

/** Human-readable single-line rendering, aligned for terminal scanning. */
function renderText(record: LogRecord): string {
  const tag = record.level.toUpperCase().padEnd(5);
  const time = record.time.slice(11, 19); // HH:MM:SS
  const fields = record.fields ? ` ${formatFields(record.fields)}` : '';
  return `${time} ${tag} ${record.msg}${fields}\n`;
}

function formatFields(fields: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** Parse a `--log-level` string into a level, or `undefined` when invalid. */
export function parseLogLevel(value: string): LogLevel | undefined {
  const normalized = value.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as LogLevel)
    : undefined;
}

/** A logger that discards everything, for tests and library consumers. */
export function nullLogger(): Logger {
  return new Logger({ level: 'silent', sink: { write: () => {} } });
}
