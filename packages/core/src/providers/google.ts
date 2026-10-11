/**
 * The Google adapter (Gemini `generateContent` API).
 *
 * Wire shape, from the documented API: a `POST /v1beta/models/{model}:generateContent`
 * with `contents`, optional `systemInstruction`, `tools`, `generationConfig`, and
 * per-part `inlineData` for images. Streaming is `streamGenerateContent`, delivered
 * over SSE (`alt=sse`), with each event a JSON `GenerateContentResponse`.
 *
 * Normalisation decisions, mirroring the shared commitments of the adapters:
 *
 *  - **Tool calls are `functionCall` parts** with their own typed `args`. When
 *    streamed they still arrive as a finished part inside
 *    `candidate.content.parts` — Gemini does not fragment tool arguments the way
 *    Anthropic does — so a tool call is emitted whole as `tool_call_start` plus one
 *    terminal `tool_call_delta`.
 *  - **Usage comes only from `usageMetadata`**, and is `undefined` when absent.
 *    `promptTokenCount` on `usageMetadata` is the *before*-completion half and is
 *    not a complete record by itself.
 *  - **The finish reason is `candidates[0].finishReason`**, mapped onto the closed
 *    enum. Google names it in SCREAMING_SNAKE (`STOP`, `MAX_TOKENS`, `TOOL_CALLS`);
 *    `SAFETY` and the other guard-rails become `'content_filter'`, and anything
 *    unrecognised becomes `'unknown'` — never a silent success.
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
  ToolDefinition,
} from './types.js';

/** Content parts we understand. */
const partSchema = z
  .object({
    text: z.string().optional(),
    inlineData: z
      .object({ mimeType: z.string().optional(), data: z.string().optional() })
      .partial()
      .optional(),
    functionCall: z
      .object({ name: z.string().optional(), args: z.unknown().optional() })
      .partial()
      .optional(),
  })
  .partial();

const contentSchema = z
  .object({ role: z.string().optional(), parts: z.array(partSchema).optional() })
  .partial();

const usageMetadataSchema = z
  .object({
    promptTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
    totalTokenCount: z.number().optional(),
  })
  .partial();

const candidateSchema = z
  .object({
    content: contentSchema.optional(),
    finishReason: z.string().nullish(),
  })
  .partial();

const responseSchema = z
  .object({
    candidates: z.array(candidateSchema).optional(),
    usageMetadata: usageMetadataSchema.optional(),
    modelVersion: z.string().optional(),
  })
  .partial();

const modelListSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().optional(),
            supportedGenerationMethods: z.array(z.string()).optional(),
            displayName: z.string().optional(),
          })
          .partial(),
      )
      .optional(),
  })
  .optional();

export interface GeminiOptions {
  readonly info: ProviderInfo;
  /** Prefix appended to the base URL for listModels. Default `/v1beta/models`. */
  readonly modelsPath?: string;
  readonly version?: string;
  readonly http?: HttpClient;
  readonly httpOptions?: HttpClientOptions;
}

const DEFAULT_VERSION = 'v1beta';

export class GeminiProvider implements Provider {
  readonly info: ProviderInfo;
  readonly baseUrl: string;
  readonly #context: ProviderContext;
  readonly #http: HttpClient;
  readonly #version: string;
  readonly #modelsPath: string;
  #health: ProviderHealth;

  constructor(context: ProviderContext, options: GeminiOptions) {
    this.#context = context;
    this.info = options.info;
    this.baseUrl = stripTrailingSlash(context.baseUrl);
    this.#http = options.http ?? new HttpClient({ log: context.log, ...options.httpOptions });
    this.#version = options.version ?? DEFAULT_VERSION;
    this.#modelsPath = options.modelsPath ?? `/v1beta/models`;
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
    for (const entry of parsed.data?.models ?? []) {
      // The id is `models/gemini-1.5-flash`; the caller wants the bare id.
      // Embeddings/tuning entries are skipped because they are not chat models:
      // they cannot `generateContent`. An entry that lists no methods but a
      // `models/` prefix is kept — availability is the probe's job, not the
      // name's.
      const name = entry.name;
      if (name === undefined || !name.startsWith('models/')) continue;
      const methods = entry.supportedGenerationMethods ?? [];
      const chat = methods.includes('generateContent') || methods.includes('streamGenerateContent');
      // Entries that explicitly do not admit `generateContent` (embeddings,
      // tuning, grounding) are enumerable but not chat models, and so are not
      // offered as completions.
      if (methods.length > 0 && !chat) continue;
      const id = name.slice('models/'.length);
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      const capabilities: Partial<{ streaming: boolean; vision: boolean }> = {};
      if (methods.includes('streamGenerateContent')) capabilities['streaming'] = true;
      if (entry.name?.toLowerCase().includes('vision') === true) capabilities['vision'] = true;

      models.push({
        id,
        providerId: this.info.id,
        ...(entry.displayName === undefined || entry.displayName === '' || entry.displayName === id
          ? {}
          : { displayName: entry.displayName }),
        ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
      });
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
      return this.#recordFailure(error);
    }
    return this.#recordFailure(
      new ProviderError(`“${this.info.id}” does not list models.`, {
        hint: `List a model with “freecode providers set ${this.info.id} models <model-id>”, then re-run.`,
      }),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Completion
  // ───────────────────────────────────────────────────────────────────────────

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = this.#generateUrl(request.model, false);
    const body = this.#buildBody(request);

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
      throw new ProviderError(`Response from “${this.info.id}” did not match the Gemini shape.`, {
        details: {
          provider: this.info.id,
          issues: parsed.error.issues.map((i) => i.path.join('.')),
        },
        hint: 'The endpoint may not be the Generative Language API after all.',
      });
    }
    const reply = parsed.data;
    const candidate = reply.candidates?.[0];

    if (candidate === undefined) {
      throw new ProviderError(`Response from “${this.info.id}” contained no candidates.`, {
        details: { provider: this.info.id },
      });
    }

    const parts = candidate.content?.parts ?? [];
    const { text, toolCalls } = deblock(parts);
    const usage = toUsage(reply.usageMetadata);

    return {
      id: reply.modelVersion ?? '',
      model: request.model,
      content: text,
      toolCalls,
      stopReason: toStopReason(candidate.finishReason),
      ...(usage === undefined ? {} : { usage }),
      latencyMs: response.latencyMs,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Streaming
  // ───────────────────────────────────────────────────────────────────────────

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const url = this.#generateUrl(request.model, true);
    const body = this.#buildBody(request);

    const response = await this.#http.requestStream({
      method: 'POST',
      url,
      headers: { ...this.#headers(), accept: 'text/event-stream' },
      body: JSON.stringify(body),
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

    let started = false;
    let stopReason: StopReason = 'unknown';
    let usage: TokenUsage | undefined;
    let sawAnyEvent = false;

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
      const parsed = responseSchema.safeParse(decoded.data);
      if (!parsed.success) continue;
      const chunk = parsed.data;

      if (!started) {
        started = true;
        yield { type: 'start', id: chunk.modelVersion ?? '', model: requestedModel };
      }

      const candidate = chunk.candidates?.[0];
      if (candidate === undefined) continue;

      const parts = candidate.content?.parts ?? [];
      for (const part of parts) {
        if (part.text !== undefined && part.text !== '') {
          yield { type: 'text', delta: part.text };
        }

        const call = part.functionCall;
        if (call !== undefined) {
          const index = 0;
          const name = call.name ?? '';
          if (name !== '') {
            // Streaming tool calls arrive as a single finished `functionCall`
            // part per response; there is no meaningful fragment stream, so the
            // whole call is emitted as start + a terminal delta.
            yield { type: 'tool_call_start', index, id: name, name };
            const args = call.args === undefined ? '{}' : JSON.stringify(call.args);
            yield { type: 'tool_call_delta', index, delta: args };
          }
        }
      }

      const finish = candidate.finishReason;
      if (finish !== undefined && finish !== null && finish !== '') {
        stopReason = toStopReason(finish);
      }

      if (chunk.usageMetadata !== undefined) {
        const through = toUsage(chunk.usageMetadata);
        if (through !== undefined) usage = through;
      }
    }

    if (!sawAnyEvent || !started) {
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
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.#context.config.headers ?? {}),
    };
    const apiKey = this.#context.apiKey;
    if (apiKey !== undefined && apiKey !== '') {
      // The credential goes in a header, never the URL. (The default base URL is
      // `https://generativelanguage.googleapis.com`, which accepts `x-goog-api-key`.)
      headers['x-goog-api-key'] = apiKey;
    }
    return headers;
  }

  #generateUrl(model: string, stream: boolean): string {
    const bare = model.startsWith('models/') ? model : `models/${model}`;
    // `alt=sse` is only meaningful for the streaming variant; a non-streaming
    // request with it is harmless but wrong, so it is only attached when the
    // endpoint will actually deliver the response as a stream.
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    return `${this.baseUrl}/${this.#version}/${bare}:${endpoint}${stream ? '?alt=sse' : ''}`;
  }

  #buildBody(request: ChatRequest): Record<string, unknown> {
    const system = splitSystem(request.messages);
    const body: Record<string, unknown> = {
      contents: request.messages.map((m) => toWireMessage(m)),
      generationConfig: {
        ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.topP === undefined ? {} : { topP: request.topP }),
        ...(request.stop !== undefined && request.stop.length > 0
          ? { stopSequences: request.stop }
          : {}),
      },
    };
    if (system !== undefined && system !== '')
      body['systemInstruction'] = { parts: [{ text: system }] };
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

function splitSystem(messages: readonly ChatMessage[]): string | undefined {
  let system: string | undefined;
  let first = 0;
  while (first < messages.length && messages[first]?.role === 'system') {
    const content = messages[first]!.content;
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
    if (text !== '') system = system === undefined ? text : `${system}\n${text}`;
    first += 1;
  }
  return system;
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  // Roles are 'user' and 'model'; tool results become 'user' parts.
  if (message.role === 'tool') {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: message.toolCallId,
            response: { result: message.content },
          },
        },
      ],
    };
  }
  if (message.role === 'assistant' && 'toolCalls' in message) {
    const parts: unknown[] = [];
    const content = message.content;
    if (typeof content === 'string') {
      if (content !== '') parts.push({ text: content });
    } else {
      for (const block of content) {
        parts.push(
          block.type === 'image'
            ? { inlineData: { mimeType: block.mediaType, data: block.dataBase64 } }
            : { text: block.text },
        );
      }
    }
    for (const call of message.toolCalls) {
      parts.push({
        functionCall: {
          name: call.name,
          args: call.argumentsJson === '' ? {} : JSON.parse(call.argumentsJson),
        },
      });
    }
    return { role: 'model', parts };
  }
  const content = 'content' in message ? message.content : '';
  const parts: unknown[] = [];
  if (typeof content === 'string') {
    if (content !== '') parts.push({ text: content });
  } else {
    for (const block of content) {
      parts.push(
        block.type === 'image'
          ? { inlineData: { mimeType: block.mediaType, data: block.dataBase64 } }
          : { text: block.text },
      );
    }
  }
  return { role: message.role === 'assistant' ? 'model' : 'user', parts };
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    ],
  };
}

/** Decompose the parts of one candidate into text plus tool calls. */
function deblock(parts: readonly z.infer<typeof partSchema>[]): {
  text: string;
  toolCalls: ToolCall[];
} {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    if (part.text !== undefined && part.text !== '') textParts.push(part.text);
    if (part.functionCall !== undefined) {
      const name = part.functionCall.name;
      if (name === undefined || name === '') continue;
      const args = part.functionCall.args;
      const argumentsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
      toolCalls.push({ id: name, name, argumentsJson });
    }
  }
  return { text: textParts.join(''), toolCalls };
}

/** Map a Gemini finish reason onto the closed enum. */
export function toStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'STOP':
    case 'stop':
      return 'end_turn';
    case 'MAX_TOKENS':
    case 'max_tokens':
      return 'max_tokens';
    case 'TOOL_CALLS':
    case 'tool_calls':
      return 'tool_use';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Build a usage record, or none when the halves are missing. */
function toUsage(raw: z.infer<typeof usageMetadataSchema> | undefined): TokenUsage | undefined {
  if (raw === undefined) return undefined;
  const inputTokens = raw.promptTokenCount;
  const outputTokens = raw.candidatesTokenCount;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;
  return { inputTokens, outputTokens };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}
