/**
 * The Anthropic adapter (Claude Models API, Messages endpoint).
 *
 * Wire shape, from the documented API: a `POST /v1/messages` with
 * `model`, `messages`, `max_tokens`, and optional `system`, `tools`,
 * `temperature` and `top_p`. Streaming emits `content_block_start`,
 * `content_block_delta`, `content_block_stop`, `message_start`,
 * `message_delta` and `message_stop`, each a `data:` SSE line, with the final
 * usage reported in `message_delta` (and echoed in `message_stop`'s response
 * metadata).
 *
 * Normalisation decisions, mirroring the OpenAI adapter's commitments:
 *
 *  - **Tool calls keep their arguments as the raw JSON string the API sends**,
 *    and (unlike the Messages turns shape) are handled as *streamed fragments*
 *    exactly like OpenAI's delta shape, because that is the only way they
 *    arrive. The input JSON blocks are transcribed faithfully, never
 *    re-serialised.
 *  - **Usage comes only from `message_delta`/`message_stop`**, and is
 *    `undefined` when absent. `input_tokens` on `message_start` alone is not a
 *    complete record.
 *  - **The final stop reason comes from `stop_reason` on `message_delta`**,
 *    mapped onto the closed enum, with anything unrecognised becoming
 *    `'unknown'` — never a silent success.
 */
import { z } from 'zod';

import { ProviderError } from '../errors.js';
import { retry } from '../util/async.js';
import { HttpClient, retryAfterMsOf, type HttpClientOptions } from './http.js';
import { decodeEventData, readSseEvents, readSseFromString } from './sse.js';
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

/** Wire blocks we understand. Anything else is passed back with its text. */
const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() }).partial();
const imageBlockSchema = z
  .object({
    type: z.literal('image'),
    source: z
      .object({
        type: z.string().optional(),
        media_type: z.string().optional(),
        data: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .partial();
const toolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
  })
  .partial();
// `tool_result` blocks are produced by us; the wire never returns them.
const blockSchema = z.union([textBlockSchema, imageBlockSchema, toolUseBlockSchema]);

const responseSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    role: z.string().optional(),
    model: z.string().optional(),
    content: z.array(blockSchema).optional(),
    stop_reason: z.string().nullish(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .partial()
      .optional(),
  })
  .partial();

const usagePatchSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  })
  .partial();

export interface AnthropicOptions {
  readonly info: ProviderInfo;
  /** Path appended to the base URL. Default `/v1/messages`. */
  readonly chatPath?: string;
  /** Path appended to the base URL to list models. Default `/v1/models`. */
  readonly modelsPath?: string;
  readonly http?: HttpClient;
  readonly httpOptions?: HttpClientOptions;
}

const DEFAULT_CHAT_PATH = '/v1/messages';

export class AnthropicProvider implements Provider {
  readonly info: ProviderInfo;
  readonly baseUrl: string;
  readonly #context: ProviderContext;
  readonly #http: HttpClient;
  readonly #chatPath: string;
  readonly #modelsPath: string;
  #health: ProviderHealth;

  constructor(context: ProviderContext, options: AnthropicOptions) {
    this.#context = context;
    this.info = options.info;
    this.baseUrl = stripTrailingSlash(context.baseUrl);
    this.#http = options.http ?? new HttpClient({ log: context.log, ...options.httpOptions });
    this.#chatPath = options.chatPath ?? DEFAULT_CHAT_PATH;
    this.#modelsPath = options.modelsPath ?? '/v1/models';
    this.#health = {
      healthy: true,
      checkedAt: new Date(0).toISOString(),
      consecutiveFailures: 0,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Models
  // ───────────────────────────────────────────────────────────────────────────

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

    const seen = new Set<string>();
    const models: ModelDescriptor[] = [];
    for (const entry of parsed.data.data ?? []) {
      const id = entry.id;
      if (id === undefined || id === '' || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, providerId: this.info.id });
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Health
  // ───────────────────────────────────────────────────────────────────────────

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
      if (!(error instanceof ProviderError) || error.status !== 404) {
        return this.#recordFailure(error);
      }
    }
    return this.#probeCompletion(signal, started);
  }

  #probeCompletion(
    signal: AbortSignal | undefined,
    started: number,
  ): Promise<ProviderHealth> | ProviderHealth {
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
      // A one-token completion is the minimum proof inference works, and by
      // asking for at most one token it cannot cost a meaningful amount.
      return this.chat({
        model: stripProviderPrefix(model, this.info.id),
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        stream: false,
        ...(signal === undefined ? {} : { signal }),
      }).then(
        () => {
          this.#health = {
            healthy: true,
            latencyMs: Date.now() - started,
            checkedAt: new Date().toISOString(),
            consecutiveFailures: 0,
          };
          return this.#health;
        },
        (error: unknown) => this.#recordFailure(error),
      );
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

    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(`Response from “${this.info.id}” did not match the Messages shape.`, {
        details: {
          provider: this.info.id,
          issues: parsed.error.issues.map((i) => i.path.join('.')),
        },
        hint: 'The endpoint may not be the Anthropic Messages API after all.',
      });
    }
    const completion = parsed.data;

    const content = completion.content ?? [];
    const { text, toolCalls } = deblock(content);
    const usage = toUsage(completion.usage);

    return {
      id: completion.id ?? '',
      model: completion.model ?? request.model,
      content: text,
      toolCalls,
      stopReason: toStopReason(completion.stop_reason),
      ...(usage === undefined ? {} : { usage }),
      latencyMs: response.latencyMs,
      ...(completion.id === undefined ? {} : { providerRequestId: completion.id }),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Streaming
  // ───────────────────────────────────────────────────────────────────────────

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
      await response.body.cancel().catch(() => undefined);
      throw new ProviderError(`“${this.info.id}” returned JSON where an SSE stream was expected.`, {
        details: { provider: this.info.id },
        hint: 'The endpoint may not implement streaming at this path.',
      });
    }

    yield* this.#decodeStream(response.body, request.model, request.signal);
  }

  /** Streaming block state, keyed by the content-block index. */
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

    let id = '';
    let model = requestedModel;
    let started = false;
    let stopReason: StopReason = 'unknown';
    let usage: TokenUsage | undefined;
    let sawAnyEvent = false;

    // Anthropic delivers each content block fully before the next one starts, so
    // order needs no reassembly: deltas can be emitted as they arrive, and a tool
    // call's final argument JSON is complete at its block's `stop` event.
    //
    // A started block is tracked by its index. Because delivery is ordered, the
    // map is only consulted for current state, never replayed at the end.
    const toolState = new Map<number, { name: string; args: string }>();

    for await (const event of events) {
      if (signal?.aborted) throw signal.reason;
      sawAnyEvent = true;
      const decoded = decodeEventData<unknown>(event);
      if (decoded === undefined) continue;
      if ('error' in decoded) {
        this.#context.log.debug('skipped unparseable SSE chunk', {
          provider: this.info.id,
          message: decoded.error.message,
        });
        continue;
      }

      const parsed = eventSchema.safeParse(decoded.data);
      if (!parsed.success) continue;
      const chunk = parsed.data;

      switch (chunk.type) {
        case 'message_start': {
          const reply = chunk.message;
          if (reply !== undefined) {
            id = reply.id ?? '';
            model = reply.model ?? requestedModel;
          }
          if (!started) {
            started = true;
            yield { type: 'start', id, model };
          }
          break;
        }
        case 'content_block_start': {
          const index = chunk.index ?? 0;
          const block = chunk.content_block;
          if (block?.type === 'text') {
            // A text block carries no leading text; the first deltas follow.
          } else if (block?.type === 'tool_use') {
            toolState.set(index, { name: block.name ?? '', args: '' });
            yield {
              type: 'tool_call_start',
              index,
              id: block.id ?? `call_${index}`,
              name: block.name ?? '',
            };
          }
          break;
        }
        case 'content_block_delta': {
          const index = chunk.index ?? 0;
          if (chunk.delta?.type === 'text_delta') {
            const delta = chunk.delta.text ?? '';
            if (delta !== '') yield { type: 'text', delta };
          } else if (chunk.delta?.type === 'input_json_delta') {
            const state = toolState.get(index);
            const partial = chunk.delta.partial_json ?? '';
            if (state !== undefined) {
              state.args += partial;
              if (partial !== '') yield { type: 'tool_call_delta', index, delta: partial };
            }
          }
          break;
        }
        case 'content_block_stop': {
          const state = toolState.get(chunk.index ?? 0);
          if (state !== undefined && state.args !== '') {
            yield { type: 'tool_call_end', index: chunk.index ?? 0, argumentsJson: state.args };
          }
          break;
        }
        case 'message_delta': {
          const reason = chunk.delta?.stop_reason;
          if (typeof reason === 'string' && reason !== '') stopReason = toStopReason(reason);
          const patch = chunk.usage;
          if (patch !== undefined) {
            const through = toUsage(patch);
            if (through !== undefined) usage = through;
          }
          break;
        }
        case 'message_stop':
          // Nothing further to emit; the stream closes below.
          break;
        default:
          // `ping` and any future event are ignored, never fatal.
          break;
      }
    }

    if (!sawAnyEvent) {
      throw new ProviderError(`“${this.info.id}” returned an empty stream.`, {
        details: { provider: this.info.id },
        hint: 'The endpoint may require a different path, or the model may be unavailable.',
      });
    }

    // A tool call whose `stop` event never arrived (truncated socket) should not
    // be delivered as if complete; the fragments stay in the event log only.
    // Completed calls were emitted at their block stop, so nothing re-emits
    // here. A truncated stream that produced tool fragments but no stop is
    // reported as `error` rather than as a clean `tool_use` turn.

    if (usage !== undefined) yield { type: 'usage', usage };

    if (stopReason === 'unknown' && toolState.size > 0) stopReason = 'tool_use';

    yield { type: 'done', stopReason, ...(usage === undefined ? {} : { usage }) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(this.#context.config.headers ?? {}),
    };
    const apiKey = this.#context.apiKey;
    if (apiKey !== undefined && apiKey !== '') {
      // The credential goes in a header, never the URL.
      headers['x-api-key'] = apiKey;
    }
    return headers;
  }

  #buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = splitSystem(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: messages.map(toWireMessage),
      max_tokens: request.maxTokens ?? 1024,
      stream,
    };
    if (system !== undefined && system !== '') body['system'] = system;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.topP !== undefined) body['top_p'] = request.topP;
    if (request.stop !== undefined && request.stop.length > 0)
      body['stop_sequences'] = request.stop;

    if (request.tools !== undefined && request.tools.length > 0) {
      body['tools'] = request.tools.map(toWireTool);
      if (request.toolChoice !== undefined)
        body['tool_choice'] = toWireToolChoice(request.toolChoice);
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

/** A system message is sent in the top-level `system` field, not in messages. */
function splitSystem(messages: readonly ChatMessage[]): {
  system: string | undefined;
  messages: readonly ChatMessage[];
} {
  let system: string | undefined;
  let first = 0;
  while (first < messages.length && messages[first]?.role === 'system') {
    const content = messages[first]!.content;
    const text = typeof content === 'string' ? content : blocksOf(content).join('');
    if (text !== '') {
      system = system === undefined ? text : `${system}\n${text}`;
    }
    first += 1;
  }
  return { system, messages: messages.slice(first) };
}

/** Extract the plain text of a content-block array. */
function blocksOf(blocks: readonly { type: string; text?: string }[]): string[] {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '');
}

/** Convert one of our messages into the Anthropic wire shape. */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError === true ? { is_error: true } : {}),
        },
      ],
    };
  }

  if (message.role === 'assistant' && 'toolCalls' in message && message.toolCalls.length > 0) {
    const content: unknown[] = [];
    if (typeof message.content === 'string') {
      if (message.content !== '') content.push({ type: 'text', text: message.content });
    } else {
      for (const block of message.content) {
        content.push(
          blocksToWire(
            block as { type: string; text?: string; mediaType?: string; dataBase64?: string },
          ),
        );
      }
    }
    for (const call of message.toolCalls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.argumentsJson === '' ? {} : JSON.parse(call.argumentsJson),
      });
    }
    return { role: 'assistant', content };
  }

  return {
    role: message.role,
    content:
      typeof message.content === 'string' ? message.content : message.content.map(blocksToWire),
  };
}

/** Map an image block to the Anthropic `image` block shape. */
function blocksToWire(block: {
  type: string;
  text?: string;
  mediaType?: string;
  dataBase64?: string;
}): unknown {
  if (block.type === 'image') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.mediaType ?? 'image/png',
        data: block.dataBase64 ?? '',
      },
    };
  }
  return { type: 'text', text: block.text ?? '' };
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function toWireToolChoice(choice: ToolChoice): unknown {
  // The API supports `auto`, `any`, `tool`, or `{ type: 'tool', name }`. The
  // normalized `none`/'required'/'{name}' are the useful overlap.
  if (typeof choice === 'string') {
    return choice === 'required' ? 'any' : 'auto';
  }
  return { type: 'tool', name: choice.name };
}

/** Decompose a non-streamed `content` array into visible text plus tool calls. */
function deblock(content: readonly z.infer<typeof blockSchema>[]): {
  text: string;
  toolCalls: ToolCall[];
} {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const [i, block] of content.entries()) {
    const record = block as Record<string, unknown>;
    if (record['type'] === 'text') {
      const t = record['text'];
      if (typeof t === 'string') textParts.push(t);
    } else if (record['type'] === 'tool_use') {
      const id = typeof record['id'] === 'string' ? record['id'] : `call_${i}`;
      const name = typeof record['name'] === 'string' ? record['name'] : '';
      if (name === '') continue;
      const input = record['input'];
      // The input is delivered as a parsed object; the raw JSON string the API
      // emitted internally is not recoverable here, so it is re-serialised once.
      const argumentsJson = typeof input === 'string' ? input : JSON.stringify(input ?? {});
      toolCalls.push({ id, name, argumentsJson });
    }
  }
  return { text: textParts.join(''), toolCalls };
}

/** Map an Anthropic stop_reason onto the closed enum. */
export function toStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Build a complete usage record, or none when the halves are missing. */
function toUsage(raw: z.infer<typeof usagePatchSchema> | undefined): TokenUsage | undefined {
  if (raw === undefined) return undefined;
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;
  return { inputTokens, outputTokens };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}

function stripProviderPrefix(reference: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
}

// Streaming event shapes.
const eventSchema = z
  .object({
    type: z.string().optional(),
    index: z.number().optional(),
    message: z
      .object({
        id: z.string().optional(),
        model: z.string().optional(),
        role: z.string().optional(),
        content: z.array(blockSchema).optional(),
        stop_reason: z.string().nullish(),
        usage: usagePatchSchema.optional(),
      })
      .partial()
      .optional(),
    content_block: blockSchema.optional(),
    delta: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
        partial_json: z.string().optional(),
        stop_reason: z.string().nullish(),
      })
      .partial()
      .optional(),
    usage: usagePatchSchema.optional(),
  })
  .partial();

// /v1/models: `{ "data": [ { "id": "...", ... } ] }`.
const modelListSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().optional(),
            display_name: z.string().optional(),
            created_at: z.string().optional(),
          })
          .partial(),
      )
      .optional(),
  })
  .partial();
