/**
 * Error responses in the shape an OpenAI client expects.
 *
 * Every failure leaves the gateway as `{ error: { message, type, code } }` with
 * an appropriate status, because that is what the CLI's adapter parses to build
 * a useful `ProviderError` — an error the client cannot read is an error the user
 * cannot act on.
 *
 * The mapping is explicit rather than "any thrown thing becomes 500", so that a
 * quota breach, a bad request and an upstream outage are distinguishable by the
 * client and by the caller watching status codes:
 *
 *   400  malformed request            `invalid_request_error`
 *   401  missing / bad gateway key    `authentication_error`
 *   404  unknown model                `invalid_request_error`
 *   429  rate limit or daily quota    `rate_limit_error` / `insufficient_quota`
 *   499  client disconnected          (no body; the response is already gone)
 *   502  upstream provider failure    `api_error`
 *   500  a bug in the gateway         `internal_error`
 *
 * **Upstream error text is redacted before it is returned.** A provider that
 * echoes the request (including the Authorization header) in its error body must
 * not be able to hand that text back through the gateway.
 */

import type { FreecodeError } from '@freecode/core';
import { ProviderError, ProviderRateLimitError, QuotaError, redact } from '@freecode/core';

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'insufficient_quota'
  | 'api_error'
  | 'internal_error';

export interface GatewayErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: ErrorType;
    readonly code: string;
    readonly param?: string;
  };
}

export class GatewayHttpError extends Error {
  readonly status: number;
  readonly type: ErrorType;
  readonly code: string;
  readonly param: string | undefined;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    type: ErrorType,
    code: string,
    message: string,
    options: { param?: string; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GatewayHttpError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = options.param;
    this.headers = options.headers ?? {};
  }

  toBody(): GatewayErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        ...(this.param === undefined ? {} : { param: this.param }),
      },
    };
  }
}

export const badRequest = (message: string, options: { param?: string; code?: string } = {}) =>
  new GatewayHttpError(400, 'invalid_request_error', options.code ?? 'invalid_request', message, {
    ...(options.param === undefined ? {} : { param: options.param }),
  });

export const unauthorized = (message: string, code = 'invalid_api_key') =>
  new GatewayHttpError(401, 'authentication_error', code, message, {
    headers: { 'www-authenticate': 'Bearer realm="freecode-gateway"' },
  });

export const notFound = (message: string, code = 'model_not_found') =>
  new GatewayHttpError(404, 'invalid_request_error', code, message);

export const serviceUnavailable = (
  message: string,
  code = 'provider_unavailable',
  cause?: unknown,
) =>
  new GatewayHttpError(502, 'api_error', code, message, {
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Map a `QuotaError`/quota decision onto a 429.
 *
 * The distinction between the two error types matters to a client that retries:
 * `rate_limit_error` (a per-minute window) is worth retrying shortly, while
 * `insufficient_quota` (an exhausted daily budget) is not — retrying it just
 * burns the caller's own patience.
 */
export function quotaError(
  code: string,
  message: string,
  _details: Readonly<Record<string, unknown>> = {},
): GatewayHttpError {
  const type: ErrorType = code === 'rate_limited' ? 'rate_limit_error' : 'insufficient_quota';
  return new GatewayHttpError(429, type, code, message, {
    headers: { 'retry-after': code === 'rate_limited' ? '60' : '3600' },
  });
}

/**
 * Wrap anything thrown by an adapter into a redacted 502.
 *
 * The upstream's own text is passed through `redact` before it is returned: a
 * provider that echoes the request (Authorization header included) in its error
 * body must not be able to hand that text back through the gateway to the caller.
 */
export function upstreamError(error: unknown, context: string): GatewayHttpError {
  const message = redact(error instanceof Error ? error.message : String(error));
  // A 429 from the upstream is the closest thing to a rate limit the gateway can
  // relay; every other upstream failure is presented as a 502, because from the
  // caller's side the gateway could not complete the request.
  if (error instanceof ProviderError && error.status === 429) {
    const retryAfter =
      error instanceof ProviderRateLimitError && error.retryAfterSeconds !== undefined
        ? String(error.retryAfterSeconds)
        : '30';
    return new GatewayHttpError(
      429,
      'rate_limit_error',
      'upstream_rate_limited',
      `${context}: ${message}`,
      { headers: { 'retry-after': retryAfter }, cause: error },
    );
  }
  return new GatewayHttpError(502, 'api_error', 'upstream_error', `${context}: ${message}`, {
    cause: error,
  });
}

/** The last-resort handler: never leak a stack or a secret to a caller. */
export function internalError(error: unknown): GatewayHttpError {
  const message = redact(error instanceof Error ? error.message : String(error));
  return new GatewayHttpError(500, 'internal_error', 'internal_error', message, {
    ...(error === undefined ? {} : { cause: error }),
  });
}

/** True for the errors whose message is already safe and user-facing. */
export function isGatewayHttpError(error: unknown): error is GatewayHttpError {
  return error instanceof GatewayHttpError;
}

/** Map a core `FreecodeError` (e.g. from a quota check) onto an HTTP error. */
export function fromFreecodeError(error: FreecodeError): GatewayHttpError {
  if (error instanceof QuotaError) {
    return quotaError('quota_exceeded', error.message, error.details);
  }
  return new GatewayHttpError(
    400,
    'invalid_request_error',
    error.code.toLowerCase(),
    error.message,
  );
}
