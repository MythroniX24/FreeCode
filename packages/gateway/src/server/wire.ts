/**
 * The OpenAI-compatible wire format.
 *
 * The gateway presents the `/v1/chat/completions` shape because that is what the
 * CLI's `openai-compatible` adapter already speaks — pointing `baseUrl` at the
 * gateway and pasting a gateway key is the whole client-side integration. Nothing
 * here is invented: the request fields are the ones that shape actually carries,
 * and the response fields are the ones an OpenAI client reads.
 *
 * Two decisions worth stating:
 *
 *  - **Parsing is lenient, validation is not.** Callers send fields this build
 *    does not model (logit bias, response format, seeds). Those are accepted and
 *    ignored rather than rejected, because a strict schema that 400s on an
 *    unknown key breaks clients for no security benefit. What *is* enforced is
 *    the shape of everything actually used.
 *  - **Images must be inline.** An `image_url` content part is only accepted as a
 *    `data:` URL. Accepting a remote URL would make the gateway fetch
 *    attacker-controlled addresses on the caller's behalf — an SSRF vector with
 *    the gateway's network position, which is exactly what `SsrfGuard` exists to
 *    prevent on the client. A non-`data:` URL is refused with a message saying so.
 */

import { randomBytes } from 'node:crypto';

import {
  UsageError,
  SSE_DONE,
  type ChatMessage,
  type ContentBlock,
  type ToolChoice,
} from '@freecode/core';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────────────────────

const imageUrlSchema = z.object({
  url: z.string().min(1),
  detail: z.string().optional(),
});

const contentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: imageUrlSchema.optional(),
});

const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .partial()
    .optional(),
});

const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

const toolSchema = z.object({
  type: z.string().optional(),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const chatRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).partial().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).max(1_000_000).optional(),
  max_completion_tokens: z.number().int().min(1).max(1_000_000).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(toolSchema).optional(),
  /** Passed through to the adapter, which understands the normalized subset. */
  tool_choice: z.unknown().optional(),
  user: z.string().optional(),
});

export type ChatRequestBody = z.infer<typeof chatRequestSchema>;

export interface NormalizedChatRequest {
  readonly model: string | undefined;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
  readonly toolChoice: ToolChoice | undefined;
  readonly stream: boolean;
  readonly includeUsage: boolean;
  readonly temperature: number | undefined;
  readonly topP: number | undefined;
  readonly maxTokens: number | undefined;
  readonly stop: readonly string[] | undefined;
}

/**
 * Turn a validated wire request into the core's normalized shapes.
 *
 * Throws `UsageError` (mapped to `400`) for the cases the schema cannot express:
 * an assistant turn whose tool calls have no id, and a tool result with no
 * `tool_call_id`. Both would fail later with a confusing upstream error, so they
 * are named here instead.
 */
export function normalizeChatRequest(body: ChatRequestBody): NormalizedChatRequest {
  const messages: ChatMessage[] = body.messages.map((message) => toCoreMessage(message));

  const tools = (body.tools ?? []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? '',
    parameters: tool.function.parameters ?? { type: 'object', properties: {} },
  }));

  const stop =
    body.stop === undefined ? undefined : typeof body.stop === 'string' ? [body.stop] : body.stop;

  return {
    model: body.model,
    messages,
    tools,
    toolChoice: toToolChoice(body.tool_choice),
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
    temperature: body.temperature,
    topP: body.top_p,
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
    stop,
  };
}

type WireMessage = z.infer<typeof messageSchema>;

function toCoreMessage(message: WireMessage): ChatMessage {
  const role = message.role;

  if (role === 'tool' || role === 'function') {
    const id = message.tool_call_id ?? message.name;
    if (id === undefined || id === '') {
      throw new UsageError('A tool message must carry “tool_call_id”.', {
        details: { role },
      });
    }
    return { role: 'tool', toolCallId: id, content: textOf(message.content) };
  }

  if (role === 'assistant') {
    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: textOf(message.content),
        toolCalls: toolCalls.map((call, index) => {
          const name = call.function?.name;
          if (name === undefined || name === '') {
            // A tool call with no name is unreplayable: the upstream cannot be
            // told which tool the assistant invoked. Naming it here beats a
            // confusing rejection from the provider.
            throw new UsageError('An assistant tool call is missing its function name.', {
              details: { index },
            });
          }
          return {
            id: call.id ?? `call_${index}`,
            name,
            argumentsJson: call.function?.arguments ?? '',
          };
        }),
      };
    }
    return { role: 'assistant', content: toCoreContent(message.content) };
  }

  if (role === 'system' || role === 'developer') {
    // `developer` is OpenAI's newer alias for the system role; both map to the
    // single `system` role the core models.
    return { role: 'system', content: textOf(message.content) };
  }

  // `user`, and anything unrecognised, is treated as user content — the safe
  // default, since it can only *add* context, never widen permissions.
  return { role: 'user', content: toCoreContent(message.content) };
}

/** Flatten content to text, ignoring non-text parts. Used where only text fits. */
function textOf(content: WireMessage['content']): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text' && part.text !== undefined)
    .map((part) => part.text ?? '')
    .join('');
}

/** Convert content to core blocks, preserving inline images. */
function toCoreContent(content: WireMessage['content']): string | readonly ContentBlock[] {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text ?? '' });
      continue;
    }
    if (part.type === 'image_url' && part.image_url !== undefined) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed === undefined) {
        throw new UsageError(
          'Only inline “data:” image URLs are accepted; remote image URLs are not fetched by the gateway.',
          { details: { url: redactUrl(part.image_url.url) } },
        );
      }
      blocks.push({ type: 'image', mediaType: parsed.mediaType, dataBase64: parsed.dataBase64 });
    }
    // Other part types (audio, files) are not modelled and are skipped.
  }

  // A single text block is returned as a plain string so providers that only
  // accept string content keep working; anything multimodal stays as blocks.
  if (blocks.length === 1 && blocks[0]?.type === 'text') return blocks[0].text;
  return blocks;
}

function parseDataUrl(url: string): { mediaType: string; dataBase64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { mediaType: match[1], dataBase64: match[2] };
}

/** Never echo a full remote URL into an error; it may carry a signed token. */
function redactUrl(url: string): string {
  if (url.startsWith('data:')) return 'data:<inline>';
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return '<unparseable>';
  }
}

function toToolChoice(value: unknown): ToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  if (typeof value === 'string') return { name: value };
  if (typeof value === 'object') {
    const fn = (value as { function?: { name?: unknown } }).function;
    const name = fn?.name;
    if (typeof name === 'string' && name !== '') return { name };
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response
// ─────────────────────────────────────────────────────────────────────────────

/** A fresh completion id in the shape OpenAI clients expect. */
export function completionId(): string {
  return `chatcmpl-${randomBytes(12).toString('hex')}`;
}

export interface WireUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export function wireUsage(inputTokens: number, outputTokens: number): WireUsage {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

export interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface WireChoiceMessage {
  readonly role: 'assistant';
  readonly content: string | null;
  readonly tool_calls?: readonly WireToolCall[];
}

export interface WireChunkChoice {
  readonly index: number;
  readonly delta: Record<string, unknown>;
  readonly finish_reason: string | null;
}

/** One streaming chunk object (the payload inside `data: …`). */
export function chunk(
  id: string,
  model: string,
  choices: readonly WireChunkChoice[],
  usage?: WireUsage,
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    ...(usage === undefined ? {} : { usage }),
  };
}

/** The opening chunk, which carries the assistant role. */
export function chunkRole(id: string, model: string): Record<string, unknown> {
  return chunk(id, model, [
    { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
  ]);
}

/** A text delta chunk. */
export function chunkText(id: string, model: string, delta: string): Record<string, unknown> {
  return chunk(id, model, [{ index: 0, delta: { content: delta }, finish_reason: null }]);
}

/** The first fragment of a tool call: id, type and name. */
export function chunkToolCallStart(
  id: string,
  model: string,
  index: number,
  callId: string,
  name: string,
): Record<string, unknown> {
  return chunk(id, model, [
    {
      index: 0,
      delta: {
        tool_calls: [{ index, id: callId, type: 'function', function: { name, arguments: '' } }],
      },
      finish_reason: null,
    },
  ]);
}

/** A fragment of a tool call's argument JSON. */
export function chunkToolCallArgs(
  id: string,
  model: string,
  index: number,
  args: string,
): Record<string, unknown> {
  return chunk(id, model, [
    {
      index: 0,
      delta: { tool_calls: [{ index, function: { arguments: args } }] },
      finish_reason: null,
    },
  ]);
}

/** The terminal chunk, carrying the stop reason and (optionally) usage. */
export function chunkFinish(
  id: string,
  model: string,
  finishReason: string,
  usage?: WireUsage,
): Record<string, unknown> {
  return chunk(id, model, [{ index: 0, delta: {}, finish_reason: finishReason }], usage);
}

/** Serialize one object as an SSE `data:` frame. */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The end-of-stream sentinel frame, built from the core's constant. */
export function sseDoneFrame(): string {
  return `data: ${SSE_DONE}\n\n`;
}

/** A comment frame, used as a keepalive while the upstream thinks. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}
