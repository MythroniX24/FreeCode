/**
 * HTTP transport shared by every provider adapter.
 *
 * Centralising the transport is what makes the security properties uniform: a
 * new adapter cannot forget to validate an endpoint, cap a response body, honour
 * a `Retry-After`, or redact an error, because it never touches `fetch` directly.
 *
 * Security properties enforced here
 * ---------------------------------
 *  - **Every URL passes the SSRF guard** before a request is made, and each
 *    redirect hop is re-validated (`MAX_REDIRECTS` cap, no https→http downgrade).
 *  - **Redirects are followed manually.** `fetch`'s built-in redirect handling
 *    would bypass the per-hop check entirely, so `redirect: 'manual'` is used and
 *    the loop is explicit.
 *  - **Response bodies are size-capped while streaming.** A hostile or broken
 *    endpoint cannot exhaust memory by promising an infinite body; the cap is
 *    enforced on bytes actually received, not on `Content-Length` alone.
 *  - **Error messages are built from a redacted body excerpt**, so a provider that
 *    echoes the request (including the Authorization header) back in its error
 *    cannot leak the key into a log.
 *  - **Credentials never appear in a URL.** The key goes in a header only.
 *
 * Known limitation, stated plainly: the connection is made to the *validated
 * hostname*, not to a pinned IP. Node's built-in `fetch` does not expose the
 * socket-level address selection that full DNS-rebinding immunity would require,
 * so undici performs its own resolution and the guard narrows the rebinding
 * window rather than closing it. A deployment that needs a hard guarantee should
 * route inference through the hosted gateway, which terminates the connection
 * server-side and is not subject to a client-side DNS race.
 */

import { nullLogger, type Logger } from '../util/logger.js';
import { NetworkError, ProviderError, ProviderRateLimitError, isAbortError } from '../errors.js';
import { redact } from '../util/redact.js';
import {
  SsrfGuard,
  MAX_REDIRECTS,
  safeUrlForDisplay,
  type SsrfGuardOptions,
} from '../security/ssrf-guard.js';

/** Default cap on a buffered response body: 32 MiB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Default cap on an error-body excerpt retained for diagnostics: 2 KiB. */
export const ERROR_EXCERPT_BYTES = 2048;

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Pre-serialized body. Adapters serialize so they control the exact bytes. */
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxResponseBytes?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Final URL after redirects. */
  readonly url: string;
  readonly latencyMs: number;
}

/** A response whose body has not been read, for streaming callers. */
export interface HttpStreamResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The live body. The caller owns it and must cancel or drain it. */
  readonly body: ReadableStream<Uint8Array>;
  /** Final URL after redirects. */
  readonly url: string;
  /** Time to first response headers. */
  readonly latencyMs: number;
}

export interface HttpClientOptions {
  readonly ssrf?: SsrfGuard;
  readonly ssrfOptions?: SsrfGuardOptions;
  readonly maxRedirects?: number;
  readonly log?: Logger;
  readonly defaultTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export class HttpClient {
  readonly #ssrf: SsrfGuard;
  readonly #maxRedirects: number;
  readonly #log: Logger;
  readonly #defaultTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpClientOptions = {}) {
    this.#ssrf = options.ssrf ?? new SsrfGuard(options.ssrfOptions);
    this.#maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
    this.#log = options.log ?? nullLogger();
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** The guard in use, exposed so adapters can validate a URL without sending. */
  get ssrf(): SsrfGuard {
    return this.#ssrf;
  }

  /**
   * Perform a request and buffer the whole body, with a byte cap.
   *
   * Never sends a body on a GET — some proxies log it, and no provider expects it.
   */
  async request(request: HttpRequest): Promise<HttpResponse> {
    const maxBytes = request.maxResponseBytes ?? this.#maxResponseBytes;
    const started = Date.now();
    const sent = await this.#send(request);

    if (sent.body === null) {
      // A 204 or 304 legitimately has no body.
      if (sent.response.status >= 400) {
        throw this.#errorForStatus(sent.response, '', sent.url);
      }
      return {
        status: sent.response.status,
        headers: sent.response.headers,
        text: '',
        url: sent.url.toString(),
        latencyMs: Date.now() - started,
      };
    }

    const text = await readCapped(sent.body, maxBytes, sent.url);
    const latencyMs = Date.now() - started;

    this.#log.debug('http response', {
      status: sent.response.status,
      url: safeUrlForDisplay(sent.url),
      bytes: text.length,
      latencyMs,
    });

    if (sent.response.status >= 400) {
      throw this.#errorForStatus(sent.response, text, sent.url);
    }

    return {
      status: sent.response.status,
      headers: sent.response.headers,
      text,
      url: sent.url.toString(),
      latencyMs,
    };
  }

  /**
   * Perform a request and hand back the unread body.
   *
   * Used for SSE: buffering a stream before parsing it would defeat the point of
   * streaming and make an idle timeout impossible to implement. Because the body
   * is left open, the *caller* is responsible for consuming or cancelling it;
   * `streamSse` below does that correctly.
   */
  async requestStream(request: HttpRequest): Promise<HttpStreamResponse> {
    const started = Date.now();
    const sent = await this.#send(request);

    if (sent.response.status >= 400) {
      // An error response is small and worth reading in full so the message is
      // useful; there is no stream to preserve.
      const text =
        sent.body === null
          ? ''
          : await readCapped(sent.body, ERROR_EXCERPT_BYTES * 8, sent.url).catch(() => '');
      throw this.#errorForStatus(sent.response, text, sent.url);
    }

    if (sent.body === null) {
      throw new ProviderError(
        `“${safeUrlForDisplay(sent.url)}” returned no body where a stream was expected.`,
        { status: sent.response.status, details: { url: safeUrlForDisplay(sent.url) } },
      );
    }

    return {
      status: sent.response.status,
      headers: sent.response.headers,
      body: sent.body,
      url: sent.url.toString(),
      latencyMs: Date.now() - started,
    };
  }

  /** Convenience wrapper: POST JSON and buffer the response. */
  async postJson<T = unknown>(
    url: string,
    body: unknown,
    options: Omit<HttpRequest, 'method' | 'url' | 'body'> = {},
  ): Promise<{ response: HttpResponse; json: T }> {
    const response = await this.request({
      ...options,
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
    });
    return { response, json: parseJsonOrThrow<T>(response.text, url) };
  }

  /** Convenience wrapper: GET and buffer the response. */
  async getJson<T = unknown>(
    url: string,
    options: Omit<HttpRequest, 'method' | 'url'> = {},
  ): Promise<{ response: HttpResponse; json: T }> {
    const response = await this.request({ ...options, method: 'GET', url });
    return { response, json: parseJsonOrThrow<T>(response.text, url) };
  }

  /**
   * Send a request, resolving redirects by hand.
   *
   * Returns the raw `Response` so the caller decides whether to buffer or stream
   * it. Redirect hops are re-validated on every step, which is the entire reason
   * this is not delegated to `fetch`.
   */
  async #send(
    request: HttpRequest,
  ): Promise<{ response: Response; body: ReadableStream<Uint8Array> | null; url: URL }> {
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    let currentUrl = request.url;

    for (let hop = 0; hop <= this.#maxRedirects; hop += 1) {
      const validated = await this.#ssrf.validate(
        currentUrl,
        hop === 0 ? 'request URL' : `redirect hop ${hop}`,
      );

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new NetworkError(`Request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();

      const onOuterAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', onOuterAbort, { once: true });

      let response: Response;
      try {
        this.#log.debug('http request', {
          method: request.method,
          url: safeUrlForDisplay(validated.url),
          hop,
        });

        response = await this.#fetch(validated.url, {
          method: request.method,
          headers: {
            ...request.headers,
            // Ask for an identity encoding: simpler byte accounting, and it
            // removes the decompression-bomb vector a hostile endpoint would
            // otherwise have.
            'accept-encoding': 'identity',
          },
          ...(request.body === undefined || request.method === 'GET' ? {} : { body: request.body }),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error) || request.signal?.aborted) throw error;
        throw new NetworkError(
          `Request to ${safeUrlForDisplay(validated.url)} failed: ${redact((error as Error).message)}`,
          { cause: error, details: { url: safeUrlForDisplay(validated.url) } },
        );
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onOuterAbort);
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        // Drain and discard so the socket can be reused.
        await response.body?.cancel().catch(() => undefined);

        if (location === null || location === '') {
          throw new ProviderError(
            `Provider returned HTTP ${response.status} without a Location header.`,
            { status: response.status, details: { url: safeUrlForDisplay(validated.url) } },
          );
        }

        if (hop === this.#maxRedirects) {
          throw new ProviderError(`Too many redirects (limit ${this.#maxRedirects}).`, {
            status: response.status,
            details: { url: safeUrlForDisplay(validated.url) },
            hint: 'Point the provider base URL directly at the API root.',
          });
        }

        // `validateRedirect` refuses an https→http downgrade and re-screens the
        // destination, which is the whole point of doing this by hand.
        const next = await this.#ssrf.validateRedirect(validated.url, location, hop + 1);
        this.#log.debug('following redirect', {
          from: safeUrlForDisplay(validated.url),
          to: safeUrlForDisplay(next.url),
          hop: hop + 1,
        });
        currentUrl = next.url.toString();
        continue;
      }

      // The timer is cleared above, so a long-lived stream is not killed by the
      // request timeout. Idle detection for streams is the caller's concern
      // (see `readStreamWithIdleTimeout`).
      return { response, body: response.body, url: validated.url };
    }

    // Unreachable: the loop returns or throws on the final hop.
    throw new ProviderError('Redirect loop terminated unexpectedly.', { retryable: false });
  }

  /**
   * Map an error status onto the right error type.
   *
   * 429 gets its own class carrying `Retry-After`, because the retry loop must
   * honour the provider's own pacing rather than an exponential guess — retrying
   * a free tier too eagerly is how an account gets throttled or flagged.
   */
  #errorForStatus(response: Response, body: string, url: URL): ProviderError {
    const excerpt = redact(truncate(body, ERROR_EXCERPT_BYTES));
    const providerMessage = extractProviderMessage(body);
    const detail = providerMessage ?? excerpt;
    const display = safeUrlForDisplay(url);

    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      return new ProviderRateLimitError(
        `Rate limited by ${display} (HTTP 429)${detail ? `: ${detail}` : ''}`,
        {
          status: 429,
          ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
          details: {
            url: display,
            ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
          },
          hint:
            retryAfter === undefined
              ? 'The provider did not say how long to wait. Pausing is the only safe option.'
              : `The provider asks you to wait ${retryAfter}s.`,
        },
      );
    }

    if (response.status === 401 || response.status === 403) {
      return new ProviderError(
        `Authentication failed at ${display} (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
        {
          status: response.status,
          retryable: false,
          details: { url: display },
          hint: 'Check that the API key for this provider is valid and has access to the requested model.',
        },
      );
    }

    if (response.status === 404) {
      return new ProviderError(`Not found at ${display} (HTTP 404)${detail ? `: ${detail}` : ''}`, {
        status: 404,
        retryable: false,
        details: { url: display },
        hint: 'The model may not exist, or the base URL may be wrong. Try “freecode models discover”.',
      });
    }

    return new ProviderError(
      `Provider returned HTTP ${response.status} from ${display}${detail ? `: ${detail}` : ''}`,
      {
        status: response.status,
        retryable: response.status >= 500 || response.status === 408,
        details: { url: display, status: response.status },
      },
    );
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Read a response body with a hard byte cap.
 *
 * Streams rather than calling `.text()`, because `.text()` buffers an unbounded
 * body before any check can run. `Content-Length` is used only as an early
 * reject; the real enforcement counts bytes received, since a chunked or lying
 * endpoint would sail past a header-only check.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  url: URL,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError(
          `Response from ${safeUrlForDisplay(url)} exceeded the ${maxBytes}-byte limit.`,
          { retryable: false, details: { url: safeUrlForDisplay(url), maxBytes } },
        );
      }
      chunks.push(value);
    }
  } finally {
    // A pending read can prevent release; cancelling first is the documented fix.
    try {
      reader.releaseLock();
    } catch {
      await reader.cancel().catch(() => undefined);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/**
 * Parse `Retry-After`, which is either delta-seconds or an HTTP-date.
 *
 * Capped at one hour: a provider asking for longer is more likely misconfigured
 * than sincere, and the caller should surface that rather than appear to hang.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Math.min(3600, Number.parseInt(trimmed, 10));

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return seconds <= 0 ? 0 : Math.min(3600, seconds);
}

/** Truncate to a character budget without splitting a surrogate pair. */
export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const sliced = value.slice(0, maxChars);
  // Drop a trailing lone high surrogate, which would otherwise render as U+FFFD.
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Pull a human-readable message out of a provider error body.
 *
 * Providers use at least four shapes for this (`error.message`, `error` as a
 * string, `message`, `detail`). Reading them is worth the small effort: the
 * difference between "HTTP 400" and "HTTP 400: model `x` does not exist" is the
 * difference between a user guessing and a user fixing it.
 */
export function extractProviderMessage(body: string): string | undefined {
  if (body.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const nested = record['error'];

  if (typeof nested === 'string' && nested !== '') return redact(truncate(nested, 500));
  if (typeof nested === 'object' && nested !== null) {
    const message = (nested as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message !== '') return redact(truncate(message, 500));
  }
  for (const key of ['message', 'detail', 'error_description']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return redact(truncate(value, 500));
  }
  return undefined;
}

/** Parse JSON, converting a failure into a ProviderError naming the endpoint. */
export function parseJsonOrThrow<T>(text: string, url: string | URL): T {
  const display = safeUrlForDisplay(url);
  if (text.trim() === '') {
    throw new ProviderError(`Empty response body from ${display}, expected JSON.`, {
      retryable: false,
      details: { url: display },
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ProviderError(
      `Response from ${display} was not valid JSON: ${redact((cause as Error).message)}`,
      {
        cause,
        retryable: false,
        details: { url: display, excerpt: redact(truncate(text, 200)) },
        hint: 'The endpoint may be returning an HTML error page rather than the API response.',
      },
    );
  }
}

/**
 * The delay a retry should wait before this attempt, honouring `Retry-After`.
 *
 * Plumbed into `util/async.ts`'s `retry()` as its `retryAfterMs` hook. Waiting the
 * provider's stated interval rather than an exponential guess is what keeps a
 * free tier usable: retrying a 429 early is how an account gets flagged.
 */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (error instanceof ProviderRateLimitError && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1000;
  }
  return undefined;
}
