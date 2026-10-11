/**
 * Server-sent events, parsed incrementally.
 *
 * Every streaming provider uses the same wire format with different payload
 * shapes, so the framing lives here and the payload decoding lives in each
 * adapter. The framing rules that actually matter in practice, and which naive
 * implementations get wrong:
 *
 *  - **Chunks split at arbitrary byte offsets**, including mid-UTF-8-sequence and
 *    mid-`data:` line. A parser must never assume a chunk ends at an event
 *    boundary, so this one buffers text and can be fed byte fragments.
 *  - **A multi-byte character split across chunks** is the classic corruption
 *    bug. `TextDecoder` is used in streaming mode (`{ stream: true }`) so a
 *    partial sequence is held rather than turned into U+FFFD.
 *  - **Multiple `data:` lines in one event concatenate with `\n`**, per the spec.
 *    Providers that send pretty-printed JSON rely on this.
 *  - **`:` starts a comment** and must be ignored — several providers send `: ping`
 *    as a keepalive, and treating it as data yields a JSON parse error.
 *  - **The stream may end without a trailing blank line**, which is common when a
 *    provider closes the connection abruptly. The final buffered event must still
 *    be delivered, or the last token is silently lost.
 *  - **`[DONE]`** is OpenAI's sentinel for end-of-stream and is not JSON. It is
 *    surfaced as a sentinel value rather than swallowed, so an adapter that
 *    forgets to handle it fails loudly instead of treating it as malformed data.
 */

import { NetworkError } from '../errors.js';
import { abortError } from '../util/async.js';

/** OpenAI's end-of-stream sentinel, sent as a bare `data: [DONE]` line. */
export const SSE_DONE = '[DONE]';

export interface SseEvent {
  /** The `event:` field, when the provider sends one. */
  readonly event?: string;
  /** Concatenated `data:` lines. */
  readonly data: string;
  /** The `id:` field, when present. */
  readonly id?: string;
}

/**
 * Incremental SSE framer.
 *
 * Feed it decoded text with `push()`; it returns whatever complete events that
 * text completed. Call `flush()` when the stream ends to drain a final event
 * that arrived without its terminating blank line.
 */
export class SseParser {
  #buffer = '';
  #decoder = new TextDecoder('utf-8', { fatal: false });

  /** Feed raw bytes. Partial multi-byte sequences are held until completed. */
  pushBytes(chunk: Uint8Array): SseEvent[] {
    return this.push(this.#decoder.decode(chunk, { stream: true }));
  }

  /** Feed already-decoded text. */
  push(text: string): SseEvent[] {
    this.#buffer += text;
    const events: SseEvent[] = [];

    // Events are separated by a blank line. `\r\n\r\n` is emitted by some
    // proxies, so both forms are recognised.
    for (;;) {
      const boundary = findEventBoundary(this.#buffer);
      if (boundary === -1) break;

      const raw = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary.length);

      const event = parseEventBlock(raw);
      if (event !== undefined) events.push(event);
    }

    return events;
  }

  /**
   * Drain a trailing event that never got its blank line.
   *
   * Returning it matters: providers that close the socket immediately after the
   * final chunk would otherwise drop the last token, which truncates output in a
   * way that is invisible to the user.
   */
  flush(): SseEvent[] {
    this.#buffer += this.#decoder.decode();
    const raw = this.#buffer;
    this.#buffer = '';
    if (raw.trim() === '') return [];
    const event = parseEventBlock(raw);
    return event === undefined ? [] : [event];
  }

  /** Discard buffered state, e.g. after a reconnect. */
  reset(): void {
    this.#buffer = '';
    this.#decoder = new TextDecoder('utf-8', { fatal: false });
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');

  if (lf === -1 && crlf === -1) return -1;
  // Prefer whichever terminator starts earlier; when they coincide (a `\n\n`
  // immediately after `\r\n\r\n`) the longer one is the real boundary.
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/**
 * Parse one event block into an event, or `undefined` when it carries no data.
 *
 * A block with no `data:` line is a keepalive or a comment, and yields nothing.
 * That is the correct outcome for `: ping` and for a lone `event:` field.
 */
export function parseEventBlock(block: string): SseEvent | undefined {
  let eventName: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single space after the colon is part of the framing, not the value.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        id = value;
        break;
      default:
        // `retry` and unknown fields are ignored; they do not affect decoding.
        break;
    }
  }

  if (dataLines.length === 0) return undefined;

  return {
    // Multiple `data:` lines join with a newline, per the spec. Providers that
    // pretty-print their JSON depend on this.
    data: dataLines.join('\n'),
    ...(eventName === undefined ? {} : { event: eventName }),
    ...(id === undefined ? {} : { id }),
  };
}

/** True when an event's data is the end-of-stream sentinel. */
export function isDoneEvent(event: SseEvent): boolean {
  return event.data.trim() === SSE_DONE;
}

/**
 * Decode an event's data as JSON.
 *
 * Returns `undefined` rather than throwing for the two cases that are routine
 * and non-fatal: the `[DONE]` sentinel, and a malformed fragment. Providers
 * occasionally emit a truncated keepalive-shaped payload, and aborting a
 * half-delivered response over one unparseable chunk is worse than skipping it.
 * Callers that need to know a chunk was dropped can compare against the raw
 * event stream; the adapter logs it.
 */
export function decodeEventData<T = unknown>(
  event: SseEvent,
): { data: T } | { error: Error } | undefined {
  const trimmed = event.data.trim();
  if (trimmed === '' || trimmed === SSE_DONE) return undefined;
  try {
    return { data: JSON.parse(trimmed) as T };
  } catch (cause) {
    return { error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}

export interface ReadSseOptions {
  readonly signal?: AbortSignal;
  /**
   * Abort when no bytes arrive for this long. Zero disables the check.
   *
   * This is the bound that actually detects a dead connection. A total timeout
   * alone is too coarse: a socket that half-closes after the first token would
   * otherwise sit until the total elapses, which for a generous stream timeout
   * means minutes of a frozen terminal.
   */
  readonly idleTimeoutMs?: number;
  /** Overall ceiling on the whole stream, in milliseconds. Zero disables it. */
  readonly totalTimeoutMs?: number;
  /** Name used in timeout messages, e.g. `groq stream`. */
  readonly label?: string;
}

/**
 * Iterate SSE events from a `fetch` response body.
 *
 * Ends cleanly when the body does, and propagates an abort by throwing — a
 * caller that aborted wants the loop to stop, not to see a truncated success.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseEvent, void, undefined> {
  const { signal, idleTimeoutMs = 0, totalTimeoutMs = 0, label = 'stream' } = options;
  const reader = body.getReader();
  const parser = new SseParser();
  const startedAt = Date.now();

  // Aborting must both unblock the pending `read()` (cancelling the reader is
  // what does that) and be *recorded*. It cannot rely on replaying
  // `signal.reason` afterwards: a generator resumption loses the abort context,
  // and `Cancelled`-style reasons identify their signal by AsyncContext rather
  // than by identity, so `signal.reason` is not something this generator can
  // throw once the framework has taken over. Capturing the reason here is what
  // makes the distinction between "the caller stopped us" and "the response
  // ended" observable at all.
  let abortReason: unknown;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    // Only `AbortController.abort()` with no argument leaves `reason`
    // undefined; a signal that already carries a reason must keep it, or the
    // caller's own error object is replaced by a generic one.
    if (signal !== undefined && signal.reason !== undefined) abortReason = signal.reason;
    void reader.cancel(abortReason).catch(() => undefined);
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  /** The caller's abort, or a generic one when the signal carried no reason. */
  const abortErrorNow = (): unknown =>
    abortReason === undefined || abortReason === null
      ? abortError(`${label} was aborted`)
      : abortReason;

  /**
   * Whether the caller has aborted.
   *
   * Checks the signal itself as well as the recorded flag: a listener attached
   * to an *already*-aborted signal is invoked asynchronously, so at generator
   * entry the flag would not yet be set and an abort would be missed.
   */
  const isAborted = (): boolean => aborted || signal?.aborted === true;

  try {
    for (;;) {
      if (isAborted()) throw abortErrorNow();
      if (totalTimeoutMs > 0 && Date.now() - startedAt > totalTimeoutMs) {
        throw new NetworkError(`${label} exceeded its ${totalTimeoutMs}ms total timeout.`, {
          retryable: false,
          details: { label, totalTimeoutMs },
        });
      }

      const result = await readWithIdleTimeout(reader, idleTimeoutMs, label);

      // Checked *before* interpreting `done`: cancelling the reader resolves a
      // pending read with `done: true`, so without this an abort is
      // indistinguishable from a clean end and a truncated response would be
      // reported as a complete one.
      if (isAborted()) throw abortErrorNow();
      if (result.done === true) break;
      if (result.value === undefined) continue;

      for (const event of parser.pushBytes(result.value)) yield event;

      // Checked again after yielding: the consumer's `await` gives the abort a
      // chance to land between the two points.
      if (isAborted()) throw abortErrorNow();
    }

    for (const event of parser.flush()) yield event;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Releasing without cancelling on a clean end lets the connection be reused;
    // a pending read can prevent release, and cancelling first is the fix.
    try {
      reader.releaseLock();
    } catch {
      await reader.cancel().catch(() => undefined);
    }
  }
}

/**
 * Frame a body that was already buffered into a string.
 *
 * Used by tests and by any caller that had to read the body up front; it goes
 * through the identical parser so a fixture cannot pass under different framing
 * rules than production traffic.
 */
export async function* readSseFromString(body: string): AsyncGenerator<SseEvent, void, undefined> {
  const parser = new SseParser();
  for (const event of parser.push(body)) yield event;
  for (const event of parser.flush()) yield event;
}

/**
 * A single read result.
 *
 * Declared locally rather than importing `ReadableStreamReadResult`, which is
 * not in the Node lib this package compiles against.
 */
interface StreamReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array | undefined;
}

/** Race a single `read()` against the idle timer. */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  label: string,
): Promise<StreamReadResult> {
  if (idleTimeoutMs <= 0) return reader.read();

  return new Promise<StreamReadResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new NetworkError(`${label} stalled: no data received for ${idleTimeoutMs}ms.`, {
          retryable: true,
          details: { label, idleTimeoutMs },
          hint: 'The connection may have been dropped by the provider or a proxy.',
        }),
      );
    }, idleTimeoutMs);
    timer.unref?.();

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Accumulates streamed tool-call fragments.
 *
 * Providers differ in how they signal a new tool call versus more arguments for
 * an existing one, and some send the `id`/`name` only on the first fragment. This
 * tracks the per-index state so an adapter's stream handler stays a thin mapping
 * from provider fields to these three methods.
 */
export class ToolCallAccumulator {
  readonly #order: number[] = [];
  readonly #byIndex = new Map<number, { id: string; name: string; args: string }>();

  /**
   * Start (or merge into) the tool call at `index`.
   *
   * `id` and `name` are only applied when non-empty, because a provider that
   * repeats the fragment for an already-started call sends them as empty strings
   * rather than omitting them.
   */
  start(index: number, id?: string, name?: string): void {
    let entry = this.#byIndex.get(index);
    if (entry === undefined) {
      entry = { id: '', name: '', args: '' };
      this.#byIndex.set(index, entry);
      this.#order.push(index);
    }
    if (id !== undefined && id !== '') entry.id = id;
    if (name !== undefined && name !== '') entry.name = name;
  }

  /** Append argument text to the call at `index`. */
  append(index: number, fragment: string): void {
    let entry = this.#byIndex.get(index);
    if (entry === undefined) {
      // Some providers omit the start fragment entirely and go straight to
      // deltas. Creating the entry here keeps the arguments rather than dropping
      // them; the id defaults to the index, which every adapter overwrites when
      // it does have a real id.
      entry = { id: String(index), name: '', args: '' };
      this.#byIndex.set(index, entry);
      this.#order.push(index);
    }
    entry.args += fragment;
  }

  /** Current state for `index`, for emitting a `tool_call_end` event. */
  get(index: number): { id: string; name: string; argumentsJson: string } | undefined {
    const entry = this.#byIndex.get(index);
    if (entry === undefined) return undefined;
    return { id: entry.id, name: entry.name, argumentsJson: entry.args };
  }

  /** Every accumulated call, in arrival order. */
  all(): { id: string; name: string; argumentsJson: string }[] {
    return this.#order
      .map((index) => this.get(index))
      .filter(
        (entry): entry is { id: string; name: string; argumentsJson: string } =>
          entry !== undefined,
      );
  }

  /** Number of distinct tool calls seen. */
  get size(): number {
    return this.#byIndex.size;
  }

  clear(): void {
    this.#order.length = 0;
    this.#byIndex.clear();
  }
}
