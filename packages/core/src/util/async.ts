/**
 * Async control-flow primitives shared by providers, the agent loop and the
 * gateway. Deliberately dependency-free and small so they can be reasoned about
 * under cancellation — which is where most hand-rolled retry/timeout code breaks.
 *
 * Every function here is cancellation-aware: when the caller's `AbortSignal`
 * fires, in-flight waits reject with an `AbortError` rather than resolving late
 * and mutating state that is no longer relevant.
 */

import { isAbortError, isRetryable } from '../errors.js';
import type { Logger } from './logger.js';

/** Rejection value used when a wait is cancelled. Matches `AbortController`. */
export function abortError(reason?: string): Error {
  const err = new Error(reason ?? 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Reject a promise that does not settle within `ms`.
 *
 * Implemented with `AbortSignal.timeout` plus an explicit race so the timeout
 * applies even to operations (like `await sleep()` in a retry loop) that do not
 * observe a signal themselves. The returned promise never leaves a dangling
 * timer behind: the timer is cleared on settle.
 */
export async function withTimeout<T>(
  ms: number,
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; message?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(abortError(options.message ?? `Timed out after ${ms}ms`));
  }, ms);
  // Do not keep the event loop alive purely for a timeout.
  timer.unref?.();

  const onParentAbort = () => controller.abort(options.signal?.reason ?? abortError());
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      throw abortError();
    }
    options.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

/** Sleep that rejects on abort instead of resolving late. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait until `predicate` returns true, polling at `intervalMs`.
 * Used by the gateway to await a database connection without a fixed sleep.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await sleep(intervalMs, options.signal);
  }
}

export interface RetryOptions {
  /** Total attempts *including* the first. `1` disables retrying. */
  readonly attempts?: number;
  /** Base delay for exponential backoff, in ms. */
  readonly baseDelayMs?: number;
  /**
   * Upper bound for a single backoff delay, in ms.
   *
   * Also the point beyond which a provider's own `Retry-After` causes the error
   * to be surfaced rather than waited on: past this, the wait is the user's
   * decision, not ours.
   */
  readonly maxDelayMs?: number;
  /** Jitter fraction applied to each delay, 0..1. Default 0.25. */
  readonly jitter?: number;
  readonly signal?: AbortSignal;
  /**
   * Decide whether to retry. Defaults to `isRetryable` (network errors and
   * 408/409/429/5xx). Returning `false` rethrows immediately.
   */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  /**
   * Called before each backoff sleep. Providers use this to honour a
   * `Retry-After` header, which must take precedence over computed backoff.
   * Return a delay in ms, or `undefined` to use the computed one.
   */
  readonly retryAfterMs?: (error: unknown, attempt: number) => number | undefined;
  /** Invoked after a failed attempt, before sleeping. Useful for logging. */
  readonly onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  /**
   * Sink for retry diagnostics. Passing a logger is how a caller gets a record
   * of throttling — which is the signal that a free tier is being pushed too
   * hard — without every adapter reimplementing the `onRetry` wiring.
   */
  readonly log?: Logger;
  /** Name used in the retry log line, e.g. `groq chat`. */
  readonly label?: string;
}

/**
 * Retry an operation with exponential backoff and jitter.
 *
 * Jitter is on by default: without it, a fleet of agents hitting the same
 * rate-limited free endpoint retries in lockstep and stays rate-limited.
 */
export async function retry<T>(
  operation: (attempt: number, signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitter = options.jitter ?? 0.25;
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => isRetryable(error));
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (options.signal?.aborted) throw abortError();
      try {
        return await operation(attempt, controller.signal);
      } catch (error) {
        lastError = error;
        // Never retry a cancellation: the caller asked us to stop.
        if (isAbortError(error) || options.signal?.aborted) throw error;
        if (attempt >= attempts || !shouldRetry(error, attempt)) throw error;

        const hinted = options.retryAfterMs?.(error, attempt);

        // A provider that asks us to wait longer than we are willing to is not a
        // retryable condition — it is a rate limit the user needs to know about.
        // Sleeping for the full requested interval (an hour, in some responses)
        // would look like a hang, so the error is surfaced with the interval
        // attached and the caller decides. This is checked *before* sleeping, so
        // no time is spent on a wait that will not be completed anyway.
        if (hinted !== undefined && hinted > maxDelayMs) throw error;

        const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        const spread = exponential * jitter;
        const computed = exponential + (Math.random() * 2 - 1) * spread;
        const delayMs = Math.max(0, Math.round(hinted ?? computed));

        options.onRetry?.({ attempt, error, delayMs });
        if (options.log !== undefined) {
          options.log.debug('retrying after failure', {
            label: options.label ?? 'operation',
            attempt,
            of: attempts,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await sleep(delayMs, controller.signal);
      }
    }
    throw lastError;
  } finally {
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Bounded-concurrency gate.
 *
 * The agent runs tools sequentially, but provider fan-out (discovery probing)
 * and the gateway (per-user concurrency limits) both need this. `acquire`
 * resolves when a slot is free and cancels cleanly via the signal, and the
 * `release` function it returns is idempotent so a `finally` block plus an
 * error path cannot double-release and corrupt the count.
 */
interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (err: unknown) => void;
  // `| undefined` is required (not merely optional) because
  // `exactOptionalPropertyTypes` distinguishes "absent" from "present but
  // undefined", and this object is constructed with both keys always set.
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

export class Semaphore {
  #available: number;
  readonly #limit: number;
  readonly #waiters: Waiter[] = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Semaphore limit must be a positive integer, got ${limit}`);
    }
    this.#limit = limit;
    this.#available = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  /** Slots currently free. */
  get available(): number {
    return this.#available;
  }

  /** Callers waiting for a slot. */
  get pending(): number {
    return this.#waiters.length;
  }

  /** Acquire a slot. Resolves with an idempotent release function. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());

    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#makeRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: undefined,
      };
      if (signal) {
        onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortError());
        };
        // Stored on the record so `#release` can detach the listener when the
        // slot is handed over, which is the only place it is removed.
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      // Hand the slot directly to the next waiter without touching #available,
      // so a burst of releases cannot race past the limit.
      waiter.resolve(this.#makeRelease());
      return;
    }
    this.#available = Math.min(this.#limit, this.#available + 1);
  }

  /** Run `fn` while holding a slot. Always releases, including on throw. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** A promise plus its resolvers. Used by the gateway's shutdown handshake. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Combine several signals into one that aborts when any input aborts.
 * `AbortSignal.any` exists on Node 20+, but wrapping keeps the reason and
 * tolerates an empty list, which `AbortSignal.any([])` does not.
 */
export function anySignal(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0]!;
  return AbortSignal.any(present);
}

/**
 * Map over items with bounded concurrency, preserving input order in the result.
 * A rejected item resolves to `null` rather than failing the batch, so one dead
 * endpoint cannot abort a whole discovery sweep — callers filter with `.filter(Boolean)`.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<R | null>> {
  const semaphore = new Semaphore(Math.max(1, limit));
  const results = await Promise.all(
    items.map((item, index) =>
      semaphore
        .run(async () => fn(item, index), signal)
        .catch((error: unknown) => {
          if (isAbortError(error)) throw error;
          return null;
        }),
    ),
  );
  return results;
}
