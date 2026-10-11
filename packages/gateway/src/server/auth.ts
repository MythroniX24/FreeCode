/**
 * Gateway API-key authentication.
 *
 * The gateway accepts a key in either of two headers, because the two clients it
 * serves speak differently and neither should have to change:
 *
 *  - `Authorization: Bearer <key>` — what the OpenAI client shape (and therefore
 *    the CLI's `openai-compatible` adapter, pointed at the gateway) sends.
 *  - `x-api-key: <key>` — the Anthropic convention, for a caller wired that way.
 *
 * **Keys never appear in a URL.** A query-string credential ends up in access
 * logs, proxy logs, and browser history; the header is the only accepted place.
 *
 * **Comparison is over digests.** Both the configured keys and the presented key
 * are SHA-256'd and compared with `timingSafeEqual`, so the comparison is
 * constant-time and the buffers are always the same length. A `===` on the raw
 * strings would leak key length and prefix through timing — a real, if slow,
 * attack on a long-lived public endpoint.
 *
 * **The principal id is derived, never the key.** `principalId` is a hash of the
 * key, so the usage ledger, the logs and the metrics can all key on an account
 * without any of them holding, or being able to recover, the secret.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export interface Principal {
  /** `key:<sha256-prefix>` — safe to log, safe to store. */
  readonly id: string;
}

export interface AuthOptions {
  /** Configured keys. Empty disables authentication entirely (dev only). */
  readonly apiKeys: readonly string[];
  readonly log: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export type AuthResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Derive the log-safe principal id for a presented key. */
export function principalIdFor(apiKey: string): string {
  return `key:${sha256Hex(apiKey).slice(0, 32)}`;
}

export class Authenticator {
  readonly #enabled: boolean;
  readonly #digests: readonly Buffer[];
  readonly #log: AuthOptions['log'];
  /** Cache of presented-key → principal id, so repeat callers pay one hash. */
  readonly #cache = new Map<string, string>();

  constructor(options: AuthOptions) {
    this.#enabled = options.apiKeys.length > 0;
    this.#digests = options.apiKeys
      .map((key) => sha256Hex(key))
      .map((hex) => Buffer.from(hex, 'hex'));
    this.#log = options.log;
    if (!this.#enabled) {
      // Said once, loudly, at construction — not on every request.
      this.#log.warn(
        'gateway authentication is DISABLED (no GATEWAY_API_KEYS configured); every caller is anonymous',
      );
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Read the presented key from the headers, preferring the Bearer form. */
  static keyFromHeaders(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): string | undefined {
    const authorization = firstValue(headers['authorization']);
    if (authorization !== undefined) {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (match?.[1] !== undefined && match[1] !== '') return match[1];
    }
    const apiKey = firstValue(headers['x-api-key']);
    if (apiKey !== undefined && apiKey.trim() !== '') return apiKey;
    return undefined;
  }

  authenticate(presentedKey: string | undefined): AuthResult {
    if (!this.#enabled) {
      // Authentication off: every caller shares one anonymous principal, so the
      // ledger still has a bucket to count against.
      const key = presentedKey ?? 'anonymous';
      return { ok: true, principal: { id: this.#cached(key) } };
    }

    if (presentedKey === undefined || presentedKey === '') {
      return { ok: false, reason: 'missing' };
    }

    const digest = Buffer.from(sha256Hex(presentedKey), 'hex');
    let matched = false;
    for (const known of this.#digests) {
      // No early exit: every candidate is compared so the loop's duration does
      // not reveal which key matched (or that any did).
      if (timingSafeEqual(known, digest)) matched = true;
    }
    if (!matched) return { ok: false, reason: 'invalid' };

    return { ok: true, principal: { id: this.#cached(presentedKey) } };
  }

  #cached(key: string): string {
    const existing = this.#cache.get(key);
    if (existing !== undefined) return existing;
    const principal = principalIdFor(key);
    // Bound the cache: a keyed-gateway caller base is small and stable, but an
    // unauthenticated deployment could see unbounded distinct "keys".
    if (this.#cache.size > 10_000) this.#cache.clear();
    this.#cache.set(key, principal);
    return principal;
  }
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
