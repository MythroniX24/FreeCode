/**
 * The OpenAI-compatible adapter.
 *
 * One adapter covers a large share of the ecosystem, because `/v1/chat/completions`
 * is the de-facto interchange format: Groq, Cerebras, Together, Fireworks, DeepSeek,
 * Mistral, OpenRouter, llama.cpp, vLLM, LM Studio, Ollama's compatibility shim and
 * more all speak it. Implementing it once, carefully, is worth far more than a
 * bespoke adapter per vendor.
 *
 * What this file deliberately does *not* do:
 *
 *  - **It does not carry a hard-coded model list.** `listModels` asks the endpoint.
 *    A bundled catalogue goes stale within weeks and, worse, invites the project to
 *    advertise models that no longer exist — which is precisely the fabrication
 *    this project forbids. Servers that cannot enumerate return an empty array.
 *  - **It does not invent usage numbers.** A response with no `usage` object yields
 *    `undefined`, and metering records "unknown" rather than zero.
 *  - **It does not assume a stop reason.** An unrecognised `finish_reason` maps to
 *    `'unknown'`, never to `'end_turn'`; treating a truncated response as complete
 *    is the failure this guards against.
 *  - **It does not retry a non-idempotent request blindly.** Only `listModels`,
 *    `chat` and `checkHealth` retry, and only on errors the transport marks
 *    retryable; a stream is never silently restarted mid-flight.
 */

import { z } from 'zod';

import { ProviderError } from '../errors.js';
import { retry } from '../util/async.js';
import { HttpClient, retryAfterMsOf, type HttpClientOptions } from './http.js';
import { decodeEventData, isDoneEvent, readSseEvents, readSseFromString } from './sse.js';
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
  ToolChoice,
  ToolDefinition,
} from './types.js';

/** Wire shapes, validated rather than trusted. */
const usageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).partial().optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().optional() })
      .partial()
      .optional(),
  })
  .partial();

const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  /**
   * Position of this call within the message.
   *
   * Only sent in the streaming shape, where it is what identifies which
   * in-progress call a later argument fragment belongs to. Absent from the
   * non-streaming shape, where the array order is authoritative.
   */
  index: z.number().optional(),
  function: z
    .object({
      name: z.string().optional(),
      // Arguments arrive as a JSON *string* in the non-streaming shape too, and
      // a few servers send a parsed object instead. Both are accepted.
      arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    })
    .partial()
    .optional(),
});

const messageSchema = z
  .object({
    role: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    // Some servers put reasoning in a non-standard field.
    reasoning_content: z.string().nullish(),
    reasoning: z.string().nullish(),
  })
  .partial();

const choiceSchema = z
  .object({
    index: z.number().optional(),
    message: messageSchema.optional(),
    delta: messageSchema.optional(),
    finish_reason: z.string().nullish(),
  })
  .partial();

const completionSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z.array(choiceSchema).optional(),
    usage: usageSchema.nullish(),
    // Present on several gateways.
    system_fingerprint: z.string().optional(),
  })
  .partial();

const modelListSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().optional(),
            created: z.number().optional(),
            owned_by: z.string().optional(),
            context_length: z.number().optional(),
            // OpenRouter-style metadata.
            name: z.string().optional(),
            top_provider: z.object({ context_length: z.number().optional() }).partial().optional(),
          })
          .partial(),
      )
      .optional(),
    // Some servers return a bare array instead of `{ data: [...] }`.
    models: z.array(z.object({ id: z.string().optional() }).partial()).optional(),
  })
  .partial();

export interface OpenAiCompatibleOptions {
  readonly info: ProviderInfo;
  /** Path appended to the base URL for chat. Default `/chat/completions`. */
  readonly chatPath?: string;
  /** Path appended to the base URL to list models. Default `/models`. */
  readonly modelsPath?: string;
  readonly http?: HttpClient;
  readonly httpOptions?: HttpClientOptions;
}

export class OpenAiCompatibleProvider implements Provider {
  readonly info: ProviderInfo;
  readonly baseUrl: string;
  readonly #context: ProviderContext;
  readonly #http: HttpClient;
  readonly #chatPath: string;
  readonly #modelsPath: string;
  #health: ProviderHealth;

  constructor(context: ProviderContext, options: OpenAiCompatibleOptions) {
    this.#context = context;
    this.info = options.info;
    // `baseUrl` always ends without a trailing slash so path joining is uniform,
    // whether the user wrote `https://api.groq.com/openai/v1` or with a slash.
    this.baseUrl = stripTrailingSlash(context.baseUrl);
    this.#http = options.http ?? new HttpClient({ log: context.log, ...options.httpOptions });
    this.#chatPath = options.chatPath ?? '/chat/completions';
    this.#modelsPath = options.modelsPath ?? '/models';
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
   * Ask the endpoint what it serves.
   *
   * A server that returns nothing usable yields an empty array. Fabricating
   * entries to make the command output look successful is explicitly not done
   * here; the caller reports "this endpoint does not enumerate models".
   */
  async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const url = `${this.baseUrl}${this.#modelsPath}`;

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

    const parsed = modelListSchema.safeParse(json);
    if (!parsed.success) return [];

    const entries = parsed.data.data ?? parsed.data.models ?? [];
    const seen = new Set<string>();
    const models: ModelDescriptor[] = [];

    for (const entry of entries) {
      const id = entry.id;
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
      seen.add(id);

      const record = entry as Record<string, unknown>;
      const contextWindow = contextWindowOf(record);
      const displayName = record['name'];
      const created = record['created'];

      models.push({
        id,
        providerId: this.info.id,
        ...(typeof displayName === 'string' && displayName !== '' && displayName !== id
          ? { displayName }
          : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(typeof created === 'number' && Number.isFinite(created)
          ? { createdAt: created * 1000 }
          : {}),
      });
    }

    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * A cheap reachability check.
   *
   * Prefers `GET /models` because it costs no tokens at all. Only when the
   * endpoint does not enumerate does it fall back to a one-token completion —
   * and it labels the result so `doctor` can say which check ran.
   */
  async checkHealth(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const models = await this.listModels(signal);
      if (models.length > 0) {
        this.#health = {
          healthy: true,
          latencyMs: Date.now() - started,
          checkedAt: new Date().toISOString(),
          consecutiveFailures: 0,
        };
        return this.#health;
      }
    } catch (error) {
      // A 404 on `/models` is normal for a single-model server; anything else
      // is a real failure worth reporting.
      if (!(error instanceof ProviderError) || error.status !== 404) {
        return this.#recordFailure(error);
      }
    }

    // The endpoint does not enumerate. A minimal completion is the only
    // remaining proof that inference works. It is capped at one token so the
    // check cannot cost a meaningful amount even on a metered key.
    //
    // The probe model comes from the provider's configured model list first,
    // then the pinned default — never from a built-in table, which would be
    // a fabricated claim about what the endpoint serves.
    const configured = this.#context.config.models[0];
    const pinned = this.#context.appConfig.defaultModel;
    const explicit = this.#context.appConfig.defaultProvider === this.info.id ? pinned : undefined;
    const model = configured ?? (explicit === undefined || explicit === '' ? undefined : explicit);

    if (model === undefined) {
      return this.#recordFailure(
        new ProviderError(
          `“${this.info.id}” does not list models, and no model is configured to probe.`,
          {
            hint: `List a model with “freecode providers set ${this.info.id} models <model-id>”, then re-run.`,
          },
        ),
      );
    }

    try {
      await this.chat({
        // A reference in `provider/model` form is shortened to the bare id the
        // wire expects; a bare id passes through unchanged.
        model: stripProviderPrefix(model, this.info.id),
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        stream: false,
        ...(signal === undefined ? {} : { signal }),
      });
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

    const parsed = completionSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(
        `Response from “${this.info.id}” did not match the chat-completions shape.`,
        {
          details: {
            provider: this.info.id,
            issues: parsed.error.issues.map((i) => i.path.join('.')),
          },
          hint: 'The endpoint may not be OpenAI-compatible after all.',
        },
      );
    }

    const completion = parsed.data;
    const choice = completion.choices?.[0];
    if (choice === undefined) {
      throw new ProviderError(`Response from “${this.info.id}” contained no choices.`, {
        details: { provider: this.info.id },
      });
    }

    const message = choice.message ?? {};
    const usage = toUsage(completion.usage);

    return {
      id: completion.id ?? '',
      model: completion.model ?? request.model,
      content: textOf(message.content),
      toolCalls: toToolCalls(message.tool_calls),
      stopReason: toStopReason(choice.finish_reason),
      ...(usage === undefined ? {} : { usage }),
      latencyMs: response.latencyMs,
      ...(completion.system_fingerprint === undefined
        ? {}
        : { providerRequestId: completion.system_fingerprint }),
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const url = `${this.baseUrl}${this.#chatPath}`;
    const body = this.#buildBody(request, true);

    const response = await this.#http.requestStream({
      method: 'POST',
      url,
      headers: { ...this.#headers(), accept: 'text/event-stream' },
      body: JSON.stringify(body),
      // The overall ceiling is generous because a reasoning model may think for
      // a while; a stalled socket is caught by the idle bound instead.
      timeoutMs: request.timeoutMs ?? this.#context.appConfig.agent.streamTimeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (response.headers.get('content-type')?.includes('application/json') === true) {
      // A non-streaming payload delivered despite `stream: true`. Reading it as
      // SSE would produce a confusing "empty stream" error; naming the real
      // problem is more useful.
      await response.body.cancel().catch(() => undefined);
      throw new ProviderError(`“${this.info.id}” returned JSON where an SSE stream was expected.`, {
        details: { provider: this.info.id },
        hint: 'The endpoint may not implement streaming at this path.',
      });
    }

    yield* this.#decodeStream(response.body, request.model, request.signal);
  }

  /** Exposed for tests: decode an SSE body that was already fully read. */
  async *#decodeStream(
    body: ReadableStream<Uint8Array> | string,
    requestedModel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const events =
      typeof body === 'string'
        ? readSseFromString(body)
        : readSseEvents(body, {
            ...(signal === undefined ? {} : { signal }),
            idleTimeoutMs: this.#context.appConfig.agent.streamIdleTimeoutMs,
            totalTimeoutMs: this.#context.appConfig.agent.streamTimeoutMs,
            label: `${this.info.id} stream`,
          });

    // Tool-call fragments are accumulated by index and emitted as a single
    // `tool_call_end`, because a fragment is not valid JSON until the last chunk.
    const fragments = new Map<number, { id: string; name: string; args: string }>();
    const order: number[] = [];

    let id = '';
    let model = requestedModel;
    let started = false;
    let stopReason: StopReason = 'unknown';
    let usage: TokenUsage | undefined;
    let sawAnyPayload = false;

    for await (const event of events) {
      if (signal?.aborted) throw signal.reason;
      if (isDoneEvent(event)) break;

      const decoded = decodeEventData<unknown>(event);
      if (decoded === undefined) continue;
      if ('error' in decoded) {
        // A single unparseable chunk must not abort a half-delivered response.
        this.#context.log.debug('skipped unparseable SSE chunk', {
          provider: this.info.id,
          message: decoded.error.message,
        });
        continue;
      }

      const parsed = completionSchema.safeParse(decoded.data);
      if (!parsed.success) continue;

      const chunk = parsed.data;
      sawAnyPayload = true;

      if (!started) {
        id = chunk.id ?? '';
        model = chunk.model ?? requestedModel;
        started = true;
        yield { type: 'start', id, model };
      }

      const chunkUsage = toUsage(chunk.usage);
      if (chunkUsage !== undefined) usage = chunkUsage;

      const choice = chunk.choices?.[0];
      if (choice === undefined) continue;

      const delta = choice.delta ?? {};

      // Reasoning is surfaced separately so the renderer can hide it by default
      // rather than concatenating it into the visible answer.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning !== '') {
        yield { type: 'reasoning', delta: reasoning };
      }

      const text = textOf(delta.content);
      if (text !== '') yield { type: 'text', delta: text };

      for (const [position, call] of (delta.tool_calls ?? []).entries()) {
        // The index is the provider's own; fall back to position when absent.
        const index = typeof call.index === 'number' ? call.index : position;
        let entry = fragments.get(index);
        if (entry === undefined) {
          entry = { id: '', name: '', args: '' };
          fragments.set(index, entry);
          order.push(index);
        }

        const callId = call.id ?? '';
        const name = call.function?.name ?? '';
        if (entry.id === '' && callId !== '') {
          entry.id = callId;
          entry.name = name;
          yield { type: 'tool_call_start', index, id: callId, name };
        }

        const args = call.function?.arguments;
        if (typeof args === 'string' && args !== '') {
          entry.args += args;
          yield { type: 'tool_call_delta', index, delta: args };
        }
      }

      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        stopReason = toStopReason(choice.finish_reason);
      }
    }

    if (!sawAnyPayload && !started) {
      throw new ProviderError(`“${this.info.id}” returned an empty stream.`, {
        details: { provider: this.info.id },
        hint: 'The endpoint may require a different path, or the model may be unavailable.',
      });
    }

    for (const index of order) {
      const entry = fragments.get(index)!;
      yield {
        type: 'tool_call_end',
        index,
        argumentsJson: entry.args === '' ? '{}' : entry.args,
      };
    }

    if (usage !== undefined) yield { type: 'usage', usage };

    // A stream that produced tool calls but no finish_reason is still a tool-use
    // turn; reporting `end_turn` would make the agent loop stop before running them.
    if (stopReason === 'unknown' && fragments.size > 0) stopReason = 'tool_use';

    yield { type: 'done', stopReason, ...(usage === undefined ? {} : { usage }) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.#context.config.headers ?? {}),
    };
    const apiKey = this.#context.apiKey;
    if (apiKey !== undefined && apiKey !== '') {
      // The credential goes in a header, never the URL: URLs are logged, stored
      // in shell history and leaked via Referer.
      headers['authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
  }

  #buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toWireMessage),
      stream,
    };

    if (request.maxTokens !== undefined) body['max_tokens'] = request.maxTokens;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.topP !== undefined) body['top_p'] = request.topP;
    if (request.stop !== undefined && request.stop.length > 0) body['stop'] = request.stop;

    if (request.tools !== undefined && request.tools.length > 0) {
      body['tools'] = request.tools.map(toWireTool);
      if (request.toolChoice !== undefined)
        body['tool_choice'] = toWireToolChoice(request.toolChoice);
    }

    if (stream) {
      // Without this, several gateways buffer the whole response and deliver it
      // at once, which defeats streaming and breaks the idle-timeout logic.
      body['stream_options'] = { include_usage: true };
    }

    // `extra` is applied last so a documented provider parameter this build does
    // not model generically can still be passed through.
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

/** Convert a message into the OpenAI wire shape. */
export function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  if (message.role === 'assistant' && 'toolCalls' in message) {
    return {
      role: 'assistant',
      // An assistant turn that only calls tools has empty content; some servers
      // reject `null` here and others reject `""`, so an empty string is used
      // when there is nothing to say.
      content:
        typeof message.content === 'string' ? message.content : textOfBlocks(message.content),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          // Passed through byte-for-byte. Re-serializing a parsed object would
          // reorder keys and break prompt caching on servers that hash them.
          arguments: call.argumentsJson === '' ? '{}' : call.argumentsJson,
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
    return {
      type: 'image_url',
      image_url: { url: `data:${block.mediaType ?? 'image/png'};base64,${block.dataBase64 ?? ''}` },
    };
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

function toWireToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

/** Extract plain text from the several shapes `content` takes. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null) {
          const record = part as Record<string, unknown>;
          if (typeof record['text'] === 'string') return record['text'];
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Normalise tool calls from the response, keeping arguments as a raw string. */
export function toToolCalls(
  raw: readonly z.infer<typeof toolCallSchema>[] | undefined,
): ToolCall[] {
  if (raw === undefined) return [];
  const calls: ToolCall[] = [];
  for (const [index, call] of raw.entries()) {
    const name = call.function?.name;
    if (typeof name !== 'string' || name === '') continue;

    const args = call.function?.arguments;
    const argumentsJson =
      typeof args === 'string' ? args : args === undefined ? '{}' : JSON.stringify(args);

    calls.push({
      // A server that omits the id gets a positional placeholder. The agent
      // loop echoes this back, and a missing id would break the tool-result
      // pairing that the next request depends on.
      id: call.id ?? `call_${index}`,
      name,
      argumentsJson,
    });
  }
  return calls;
}

export function toUsage(
  raw: z.infer<typeof usageSchema> | null | undefined,
): TokenUsage | undefined {
  if (raw === null || raw === undefined) return undefined;
  const inputTokens = raw.prompt_tokens;
  const outputTokens = raw.completion_tokens;
  // Both halves must be present for the record to be meaningful. A response
  // reporting only a total is treated as "usage unknown" rather than being
  // split by guesswork.
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;

  const cached = raw.prompt_tokens_details?.cached_tokens;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;

  return {
    inputTokens,
    outputTokens,
    ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}),
    ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * Map a provider stop reason onto the closed enum.
 *
 * Unrecognised values become `'unknown'`, which callers must not treat as a
 * successful completion.
 */
export function toStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Read a context window from whichever of the two documented locations holds it.
 *
 * Returns `undefined` when the provider does not state one. Guessing a window
 * from the model's name would put a fabricated number in front of the routing
 * engine, which then packs a prompt that silently overflows.
 */
function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  const direct = entry['context_length'];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;

  const topProvider = entry['top_provider'];
  if (typeof topProvider === 'object' && topProvider !== null) {
    const nested = (topProvider as Record<string, unknown>)['context_length'];
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  }
  return undefined;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}

/**
 * Reduce `provider/model` to the bare model id the wire expects.
 *
 * Only strips a prefix that names *this* provider: a model id that legitimately
 * contains a slash (OpenRouter's `meta-llama/llama-3.3-70b`) must survive
 * untouched, and `other/model` must not be silently rewritten into a model this
 * provider has never heard of.
 */
function stripProviderPrefix(reference: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
}
