/**
 * Error hierarchy for FreeCode.
 *
 * Every error carries a stable machine-readable `code` and a process `exitCode`,
 * so CLI command handlers can map failures onto documented exit codes without
 * string-matching messages. Messages are always safe to print: they must never
 * contain credentials (see `util/redact.ts` — the CLI runs every message through
 * the redactor before display as a second line of defence).
 */

/** Documented process exit codes. Kept in one place so tests can assert on them. */
export const ExitCode = {
  /** Command completed successfully. */
  Ok: 0,
  /** Unexpected internal failure (bug). */
  Internal: 1,
  /** Command-line usage error: bad flag, missing argument. */
  Usage: 2,
  /** Configuration is missing, malformed, or fails validation. */
  Config: 3,
  /** No credentials available for the requested provider / gateway. */
  Auth: 4,
  /** Network failure: DNS, TLS, connection refused, timeout. */
  Network: 5,
  /** The provider returned an error response. */
  Provider: 6,
  /** The operation was denied by a security policy or refused by the user. */
  Denied: 7,
  /** A quota, budget, or rate limit was reached. */
  Quota: 8,
  /** The user interrupted the operation. */
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface FreecodeErrorOptions {
  /** Stable machine-readable identifier, e.g. `CONFIG_INVALID`. */
  readonly code: string;
  /** Process exit code to use when this error reaches the top level. */
  readonly exitCode?: ExitCodeValue;
  /** Additional context. Must never contain secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Underlying error, preserved for `--debug` stack output. */
  readonly cause?: unknown;
  /** Whether retrying the identical operation could plausibly succeed. */
  readonly retryable?: boolean;
  /** Suggested remediation shown to the user. */
  readonly hint?: string;
}

/** Base class for all errors FreeCode raises deliberately. */
export class FreecodeError extends Error {
  readonly code: string;
  readonly exitCode: ExitCodeValue;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly hint: string | undefined;

  constructor(message: string, options: FreecodeErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.exitCode = options.exitCode ?? ExitCode.Internal;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
    this.hint = options.hint;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Serializable shape used by `--json` output and the logger. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(Object.keys(this.details).length === 0 ? {} : { details: this.details }),
      retryable: this.retryable,
    };
  }
}

export class UsageError extends FreecodeError {
  constructor(message: string, options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, { ...options, code: 'USAGE', exitCode: ExitCode.Usage });
  }
}

export class ConfigError extends FreecodeError {
  constructor(message: string, options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, { ...options, code: 'CONFIG', exitCode: ExitCode.Config });
  }
}

export class AuthError extends FreecodeError {
  constructor(message: string, options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, { ...options, code: 'AUTH', exitCode: ExitCode.Auth });
  }
}

export class NetworkError extends FreecodeError {
  constructor(message: string, options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, {
      retryable: true,
      ...options,
      code: 'NETWORK',
      exitCode: ExitCode.Network,
    });
  }
}

export class ProviderError extends FreecodeError {
  /** HTTP status from the provider, when the failure came from a response. */
  readonly status: number | undefined;

  constructor(
    message: string,
    options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> & {
      status?: number;
      code?: string;
    } = {},
  ) {
    const { status, code, ...rest } = options;
    super(message, { ...rest, code: code ?? 'PROVIDER', exitCode: ExitCode.Provider });
    this.status = status;
  }

  /**
   * A hostname failed to resolve. Surfaced as a ProviderError rather than a
   * NetworkError because a custom provider endpoint that does not resolve is
   * almost always a configuration mistake, and the exit code should point the
   * user at `providers.<id>.baseUrl` rather than at their network.
   */
  static fromDns(hostname: string, cause?: unknown): ProviderError {
    return new ProviderError(`Cannot resolve provider host “${hostname}”.`, {
      details: { hostname },
      cause,
      retryable: false,
      hint: 'Check the provider base URL, and confirm DNS works in this environment.',
    });
  }
}

/**
 * A provider returned HTTP 429 or an exhausted-quota signal.
 * Distinct from `QuotaError` (which is *our* limit) so the user can tell whether
 * to wait for their own budget to reset or for the provider's.
 */
export class ProviderRateLimitError extends ProviderError {
  /** Seconds to wait before retrying, from `Retry-After` when present. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> & {
      status?: number;
      retryAfterSeconds?: number;
    } = {},
  ) {
    const { retryAfterSeconds, ...rest } = options;
    super(message, { ...rest, code: 'PROVIDER_RATE_LIMIT', retryable: true });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A security policy or the user denied an operation. */
export class PolicyDeniedError extends FreecodeError {
  constructor(message: string, options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, { ...options, code: 'POLICY_DENIED', exitCode: ExitCode.Denied });
  }
}

export class QuotaError extends FreecodeError {
  constructor(message: string, options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> = {}) {
    super(message, { ...options, code: 'QUOTA_EXCEEDED', exitCode: ExitCode.Quota });
  }
}

export class InterruptedError extends FreecodeError {
  constructor(
    message = 'Operation interrupted by user',
    options: Omit<FreecodeErrorOptions, 'code' | 'exitCode'> = {},
  ) {
    super(message, { ...options, code: 'INTERRUPTED', exitCode: ExitCode.Interrupted });
  }
}

/**
 * Narrow an unknown thrown value to a FreecodeError.
 *
 * Node and provider SDKs throw non-Error values; abort errors surface as
 * `DOMException`; JSON parsing throws `SyntaxError`. Callers that only care about
 * *some* structured error should still get a useful code out of it.
 */
export function toFreecodeError(value: unknown): FreecodeError {
  if (value instanceof FreecodeError) return value;

  if (isAbortError(value)) {
    return new InterruptedError('Operation was aborted', { cause: value });
  }

  if (value instanceof Error) {
    const cause = value as NodeJS.ErrnoException;
    if (cause.code === 'ENOTFOUND' || cause.code === 'EAI_AGAIN') {
      return new NetworkError(`Cannot resolve host: ${value.message}`, { cause: value });
    }
    if (cause.code === 'ECONNREFUSED' || cause.code === 'ECONNRESET' || cause.code === 'EPIPE') {
      return new NetworkError(`Connection failed: ${value.message}`, { cause: value });
    }
    if (cause.code === 'ETIMEDOUT' || cause.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new NetworkError(`Connection timed out: ${value.message}`, { cause: value });
    }
    return new FreecodeError(value.message || 'Unknown error', { code: 'INTERNAL', cause: value });
  }

  return new FreecodeError(typeof value === 'string' ? value : 'Unknown error', {
    code: 'INTERNAL',
    details: { thrown: typeof value },
  });
}

/**
 * True for `AbortError` from `AbortController` and from `undici`/`fetch`.
 * Checked structurally because the `DOMException` constructor is not always the
 * one the caller's runtime produced (different realms in tests).
 */
export function isAbortError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const name = (value as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** True when an error is worth retrying: network failures and 429/5xx responses. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof FreecodeError) {
    if (error.retryable) return true;
    if (error instanceof ProviderError && error.status !== undefined) {
      return (
        error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
      );
    }
    return false;
  }
  if (isAbortError(error)) return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE'
  );
}
