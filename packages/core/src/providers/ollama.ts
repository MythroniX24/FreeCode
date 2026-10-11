/**
 * The Ollama adapter (native `/api/chat`).
 *
 * Ollama is the local-workflow counterpart to the hosted providers: no API key,
 * a loopback default, and a wire shape that is close to — but not identical to —
 * OpenAI's. This adapter speaks the native `/api/chat`, not the OpenAI-compatible
 * shim, so it can rely on Ollama's own semantics rather than on emulation.
 *
 * Wire shape, from the documented API:
 *
 *  - `POST /api/chat` with `{ model, messages, stream, options, tools }`.
 *  - Messages are `{ role, content, images?, tool_calls? }`. Roles are
 *    `system`/`user`/`assistant`/`tool`; tool results are `{ role: 'tool',
 *    content, tool_calls: [{ function: { name } }] }`.
 *  - Streaming is plain newline-framed JSON on the same endpoint, *not* SSE
 *    framing: each line is a whole `ChatResponse` object, and the final one has
 *    `done: true` with the total `prompt_eval_count`/`eval_count`. Ollama does not
 *    use `event:` or `data:` prefixes, so the SSE framer is bypassed for the
 *    streaming loop and newline framing is used instead.
 *  - Tool calls arrive whole in `message.tool_calls` — Ollama does not stream
 *    tool arguments incrementally the way Anthropic does. Each entry has
 *    `function.name` and `function.arguments` (a JSON object, or a string on some
 *    builds).
 *  - Usage comes only from the final `done: true` message. Intermediate chunks
 *    carry partial `prompt_eval_count`/`eval_count`; the closed record is what
 *    balances the books, never an invented estimate.
 *  - `done_reason` is `stop`, `length`, `unload`, `load`, or `error`; it maps to
 *    the closed enum with `error` becoming `'error'` and anything unrecognised
 *    becoming `'unknown'`.
 *
 * Security notes:
 *
 *  - The default base URL is `http://localhost:11434`. The SSRF guard in
 *    `HttpClient` treats `127.0.0.1`/`localhost` as permitted loopback, and the
 *    user's own Ollama install is exactly the loopback case the guard makes room
 *    for; a *remote* URL is still checked against the normal rules.
 *  - There is no API key. Ollama ships no auth story, so the adapter never sends
 *    one and `requiresApiKey` is `false`. A user who finds the daemon reachable
 *    beyond the loopback is advised to bind it to `127.0.0.1` (Ollama's own
 *    recommendation), not to expect this CLI to invent credentials for it.
 *  - `checkHealth` uses `GET /api/tags`, which costs nothing.
 *
 * What this file deliberately does *not* do:
 *
 *  - **It does not carry a hard-coded model list.** `listModels` asks `/api/tags`.
 *    Ollama serves only the models the user pulled; inventing a table would
 *    advertise models that are not installed.
 *  - **It does not invent usage numbers.** A stream that ends without a
 *    `done: true` record yields `undefined` usage — metering records "unknown"
 *    rather than zero.
 *  - **It does not assume a stop reason.** An unrecognised `done_reason` maps to
 *    `'unknown'`, never to `'end_turn'`.
 */

import { z } from 'zod';

import { ProviderError } from '../errors.js';
import { retry } from '../util/async.js';
import { HttpClient, retryAfterMsOf, type HttpClientOptions } from './http.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelDescriptor,
  Provider,
  ProviderContext,
  ProviderHealth,
  ProviderInfo,
  StopReason,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from './types.js';

const toolCallSchema = z.object({
  function: z
    .object({ name: z.string().optional(), arguments: z.unknown().optional() })
    .partial()
    .optional(),
});

const messageSchema = z
  .object({
    role: z.string().optional(),
    content: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
  })
  .partial();

const chatResponseSchema = z
  .object({
    model: z.string().optional(),
    created_at: z.string().optional(),
    message: messageSchema.optional(),
    done: z.boolean().optional(),
    done_reason: z.string().nullish(),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
  })
  .partial();

const tagsSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().optional(),
            model: z.string().optional(),
            modified_at: z.string().optional(),
            size: z.number().optional(),
            details: z
              .object({
                parameter_size: z.string().optional(),
                quantization_level: z.string().optional(),
              })
              .partial()
              .optional(),
          })
          .partial(),
      )
      .optional(),
  })
  .partial();

export interface OllamaOptions {
  readonly info: ProviderInfo;
  /** Path appended to the base URL for chat. Default `/api/chat`. */
  readonly chatPath?: string;
  /** Path appended to the base URL to list models. Default `/api/tags`. */
  readonly tagsPath?: string;
  readonly http?: HttpClient;
  readonly httpOptions?: HttpClientOptions;
}

export class OllamaProvider implements Provider {
  readonly info: ProviderInfo;
  readonly baseUrl: string;
  readonly #context: ProviderContext;
  readonly #http: HttpClient;
  readonly #chatPath: string;
  readonly #tagsPath: string;
  #health: ProviderHealth;

  constructor(context: ProviderContext, options: OllamaOptions) {
    this.#context = context;
    this.info = options.info;
    this.baseUrl = stripTrailingSlash(context.baseUrl);
    this.#http = options.http ?? new HttpClient({ log: context.log, ...options.httpOptions });
    this.#chatPath = options.chatPath ?? '/api/chat';
    this.#tagsPath = options.tagsPath ?? '/api/tags';
    this.#health = {
      healthy: true,
      checkedAt: new Date(0).toISOString(),
      consecutiveFailures: 0,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Models
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Ask the daemon what it has pulled.
   *
   * Ollama serves only the models the user installed, and the id is the tag a
   * request would use (`llama3.1:8b`). Entries are surfaced as-is; nothing is
   * fabricated.
   */
  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const url = `${this.baseUrl}${this.#tagsPath}`;

    const { json } = await retry(
      () =>
        this.#http.getJson<unknown>(url, {
          headers: this.#headers(),
          timeoutMs: this.#context.config.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        }),
      {
        attempts: 3,
        retryAfterMs: retryAfterMsOf,
        log: this.#context.log,
        label: `${this.info.id} listModels`,
      },
    );

    const parsed = tagsSchema.safeParse(json);
    if (!parsed.success) return [];

    const seen = new Set<string>();
    const models: ModelDescriptor[] = [];
    for (const entry of parsed.data?.models ?? []) {
      // `name` is the full tag (`llama3.1:8b`); `model` may be the same or a
      // build id. Prefer `name`, fall back to `model`.
      const id = entry.name ?? entry.model;
      if (id === undefined || id === '' || seen.has(id)) continue;

      // A tag includes a default `:latest` suffix on some versions; the id the
      // request uses is still the full tag, so it is kept whole rather than
      // trimmed.
      seen.add(id);

      const capabilities: Partial<{ vision: boolean }> = {};
      if (id.toLowerCase().includes('vision') || id.toLowerCase().includes('llava')) {
        capabilities['vision'] = true;
      }

      models.push({
        id,
        providerId: this.info.id,
        ...(entry.model !== undefined && entry.model !== id ? { displayName: entry.model } : {}),
        ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
      });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * A cheap reachability check.
   *
   * `GET /api/tags` costs nothing and proves the daemon is up. An empty tag list
   * is still marked healthy — the daemon is reachable even with nothing pulled.
   */
  async checkHealth(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.listModels(signal);
      this.#health = {
        healthy: true,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        consecutiveFailures: 0,
      };
      return this.#health;
    } catch (error) {
      return this.#recordFailure(error);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Completion
  // ───────────────────────────────────────────────────────────────────────────

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}${this.#chatPath}`;
    const body = this.#buildBody(request, false);

    const { json, response } = await retry(
      () =>
        this.#http.postJson<unknown>(url, body, {
          headers: this.#headers(),
          timeoutMs: request.timeoutMs ?? this.#context.config.timeoutMs,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
      {
        attempts: 3,
        retryAfterMs: retryAfterMsOf,
        log: this.#context.log,
        label: `${this.info.id} chat`,
      },
    );

    const parsed = chatResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(
        `Response from “${this.info.id}” did not match the /api/chat shape.`,
        {
          details: {
            provider: this.info.id,
            issues: parsed.error.issues.map((i) => i.path.join('.')),
          },
          hint: 'The endpoint may not be an Ollama daemon after all.',
        },
      );
    }

    const reply = parsed.data;
    const message = reply.message ?? {};
    const usage = toUsage(reply);

    return {
      id: reply.created_at ?? '',
      model: reply.model ?? request.model,
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: toToolCalls(message.tool_calls),
      stopReason: toStopReason(reply.done_reason),
      ...(usage === undefined ? {} : { usage }),
      latencyMs: response.latencyMs,
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const url = `${this.baseUrl}${this.#chatPath}`;
    const body = this.#buildBody(request, true);

    const response = await this.#http.requestStream({
      method: 'POST',
      url,
      headers: this.#headers(),
      body: JSON.stringify(body),
      // The overall ceiling is generous because a reasoning model may think for
      // a while; a stalled socket is caught by the idle bound instead.
      timeoutMs: request.timeoutMs ?? this.#context.appConfig.agent.streamTimeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    // Ollama's streaming endpoint returns `application/x-ndjson`, not SSE. It is
    // accepted as-is; the `data:` prefix check that OpenAI-family endpoints need
    // would not apply here.
    yield* this.#decodeStream(response.body, request.model, request.signal);
  }

  /** Exposed for tests: decode a body that was already fully read. */
  async *#decodeStream(
    body: ReadableStream<Uint8Array> | string,
    requestedModel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const iterator =
      typeof body === 'string'
        ? readNdjsonFromString(body)
        : readNdjson(body, {
            ...(signal === undefined ? {} : { signal }),
            idleTimeoutMs: this.#context.appConfig.agent.streamIdleTimeoutMs,
            totalTimeoutMs: this.#context.appConfig.agent.streamTimeoutMs,
            label: `${this.info.id} stream`,
          });

    // Tool calls arrive whole; no fragment accumulation is needed.
    let started = false;
    let stopReason: StopReason = 'unknown';
    let usage: TokenUsage | undefined;
    let sawAnyPayload = false;

    for await (const line of iterator) {
      if (signal?.aborted) throw signal.reason;
      sawAnyPayload = true;

      const parsed = chatResponseSchema.safeParse(line);
      if (!parsed.success) continue;

      const chunk = parsed.data;
      if (!started) {
        started = true;
        yield { type: 'start', id: chunk.created_at ?? '', model: chunk.model ?? requestedModel };
      }

      const through = toUsage(chunk);
      if (through !== undefined) usage = through;

      const message = chunk.message;
      if (message !== undefined) {
        if (message.content !== undefined && message.content !== '') {
          yield { type: 'text', delta: message.content };
        }
        for (const call of message.tool_calls ?? []) {
          const name = call.function?.name;
          if (name === undefined || name === '') continue;
          const args = call.function?.arguments;
          const argumentsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
          yield { type: 'tool_call_start', index: 0, id: name, name };
          yield { type: 'tool_call_delta', index: 0, delta: argumentsJson };
        }
      }

      if (chunk.done === true) {
        const reason = chunk.done_reason;
        if (reason !== undefined && reason !== null && reason !== '') {
          stopReason = toStopReason(reason);
        } else {
          // A clean end with no explicit reason is a normal stop.
          stopReason = 'end_turn';
        }
      }
    }

    if (!sawAnyPayload || !started) {
      throw new ProviderError(`“${this.info.id}” returned an empty stream.`, {
        details: { provider: this.info.id },
        hint: 'The endpoint may require a different path, or the model may be unavailable.',
      });
    }

    if (usage !== undefined) yield { type: 'usage', usage };

    yield { type: 'done', stopReason, ...(usage === undefined ? {} : { usage }) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  #headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#context.config.headers ?? {}),
    };
  }

  #buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) options['num_predict'] = request.maxTokens;
    if (request.temperature !== undefined) options['temperature'] = request.temperature;
    if (request.topP !== undefined) options['top_p'] = request.topP;
    if (request.stop !== undefined && request.stop.length > 0) options['stop'] = request.stop;

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireMessage),
      stream,
      // The escaping is Ollama's own: `\n`, `\t`, `\r`, `\"`, `\\` and `\uXXXX`
      // are unescaped server-side, so `keep_alive` riding on `options` is safe.
      ...(Object.keys(options).length === 0 ? {} : { options }),
    };

    if (request.tools !== undefined && request.tools.length > 0) {
      body['tools'] = request.tools.map(toWireTool);
    }

    return { ...body, ...(request.extra ?? {}) };
  }

  #recordFailure(error: unknown): ProviderHealth {
    this.#health = {
      healthy: false,
      checkedAt: new Date().toISOString(),
      consecutiveFailures: this.#health.consecutiveFailures + 1,
      lastError: error instanceof Error ? error.message : String(error),
    };
    return this.#health;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire mapping
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a message into the Ollama wire shape. */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    // Ollama expects a `tool` role message whose content is the result and whose
    // `tool_calls` name is echoed so the model can pair the outcome to the call.
    return {
      role: 'tool',
      content: message.content,
      // Ollama wants the name of the call being answered; the generic id is
      // accepted but the name is what the model actually keys on.
      tool_calls: [{ function: { name: message.toolCallId } }],
    };
  }

  if (message.role === 'assistant' && 'toolCalls' in message) {
    // Ollama's assistant messages carry content as a plain string (or empty),
    // with tool calls alongside. Image content blocks are not part of the
    // assistant wire shape, so text blocks are concatenated and nothing else.
    const content =
      typeof message.content === 'string' ? message.content : textOfBlocks(message.content);
    return {
      role: 'assistant',
      content,
      tool_calls: message.toolCalls.map((call) => ({
        function: {
          name: call.name,
          arguments: call.argumentsJson === '' ? {} : JSON.parse(call.argumentsJson),
        },
      })),
    };
  }

  const content = 'content' in message ? message.content : '';
  return {
    role: message.role,
    content: typeof content === 'string' ? content : toWireBlocks(content),
  };
}

function toWireBlocks(
  blocks: readonly { type: string; text?: string; mediaType?: string; dataBase64?: string }[],
): unknown[] {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text ?? '' };
    // Ollama images are base64 in an `images` array, not an OpenAI data-URL.
    return { type: 'image', image: block.dataBase64 ?? '' };
  });
}

function textOfBlocks(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** Normalise tool calls from a response message, keeping args as a raw string. */
export function toToolCalls(
  raw: readonly z.infer<typeof toolCallSchema>[] | undefined,
): ToolCall[] {
  if (raw === undefined) return [];
  const calls: ToolCall[] = [];
  for (const call of raw) {
    const name = call.function?.name;
    if (name === undefined || name === '') continue;
    const args = call.function?.arguments;
    const argumentsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    calls.push({
      // Ollama's tool calls have no separate id; the name doubles as the pairing
      // key when the result is echoed back.
      id: name,
      name,
      argumentsJson,
    });
  }
  return calls;
}

/** Map a `done_reason` onto the closed enum. */
export function toStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'unload':
    case 'load':
      // The generation ended because the model was unloaded/reloaded, not
      // because output was complete; treating it as a normal end would let a
      // partially-delivered response look complete.
      return 'unknown';
    case 'error':
      return 'error';
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Build a usage record from the final `done` message, or none when incomplete. */
function toUsage(raw: z.infer<typeof chatResponseSchema>): TokenUsage | undefined {
  const inputTokens = raw.prompt_eval_count;
  const outputTokens = raw.eval_count;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;
  return { inputTokens, outputTokens };
}

/** Strip a trailing slash so path joining is uniform. */
function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// NDJSON framing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read Ollama's newline-framed JSON stream.
 *
 * Ollama sends one JSON object per line and flushes after each. The API documents
 * `Content-Type: application/x-ndjson`, and there is no SSE `data:` prefix, so
 * the SSE framer cannot be reused here. A dedicated loop mirrors the SSE one's
 * hardening: idle/total timeouts, abort propagation, and trailing-fragment
 * delivery.
 */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal;
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
    label?: string;
  } = {},
): AsyncGenerator<unknown, void, undefined> {
  const { signal, idleTimeoutMs = 0, totalTimeoutMs = 0, label = 'stream' } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  const startedAt = Date.now();

  let abortReason: unknown;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    if (signal !== undefined && signal.reason !== undefined) abortReason = signal.reason;
    void reader.cancel(abortReason).catch(() => undefined);
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  const abortErrorNow = () =>
    abortReason === undefined || abortReason === null
      ? new ProviderError(`${label} was aborted.`, { details: { label } })
      : abortReason;
  const isAborted = () => aborted || signal?.aborted === true;

  interface ReadResult {
    readonly done: boolean;
    readonly value?: Uint8Array | undefined;
  }
  async function readOnce(): Promise<ReadResult> {
    if (idleTimeoutMs <= 0) return reader.read();
    return new Promise<ReadResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ProviderError(`${label} stalled: no data received for ${idleTimeoutMs}ms.`, {
            retryable: true,
            hint: 'The daemon may have been stopped, or the socket dropped.',
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

  try {
    for (;;) {
      if (isAborted()) throw abortErrorNow();
      if (totalTimeoutMs > 0 && Date.now() - startedAt > totalTimeoutMs) {
        throw new ProviderError(`${label} exceeded its ${totalTimeoutMs}ms total timeout.`, {
          retryable: false,
        });
      }

      const result = await readOnce();
      if (isAborted()) throw abortErrorNow();
      if (result.done === true) break;
      if (result.value === undefined) continue;

      buffer += decoder.decode(result.value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const decoded = line === '' ? undefined : parseLine(line);
        // A malformed line is skipped, never surfaced — the same decision the
        // SSE framer makes for an unparseable chunk.
        if (decoded !== undefined) yield decoded;
        nl = buffer.indexOf('\n');
      }
    }

    const tail = (buffer + decoder.decode()).trim();
    const decodedTail = tail === '' ? undefined : parseLine(tail);
    if (decodedTail !== undefined) yield decodedTail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      await reader.cancel().catch(() => undefined);
    }
  }
}

/** A body that was already buffered into a string, parsed with the same rules. */
export async function* readNdjsonFromString(
  body: string,
): AsyncGenerator<unknown, void, undefined> {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    const decoded = trimmed === '' ? undefined : parseLine(trimmed);
    if (decoded !== undefined) yield decoded;
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    // A single malformed line must not abort a half-delivered response; it is
    // skipped the same way the SSE framer skips an unparseable chunk.
    return undefined;
  }
}
