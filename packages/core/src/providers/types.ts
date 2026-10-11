/**
 * The normalized provider contract.
 *
 * Every adapter — OpenAI-compatible, Anthropic, Google, Ollama, the hosted
 * gateway — presents the same interface. The agent loop and the router are
 * written against *this*, never against a vendor SDK, so adding a provider is a
 * new file in `providers/` and nothing else.
 *
 * Normalization decisions worth stating, because they are lossy in both
 * directions:
 *
 *   - **Tool calls are normalized to `ToolCall` with `arguments` as a raw JSON
 *     string**, not a parsed object. Providers stream tool arguments as
 *     fragments that are not valid JSON until the final chunk, and re-serializing
 *     a parsed object silently changes key order (which breaks prompt caching on
 *     some providers). Parsing happens once, at the tool-execution boundary.
 *
 *   - **Usage is optional and never fabricated.** A provider that does not report
 *     token counts yields `undefined`, and metering treats it as unknown rather
 *     than as zero. Inventing a count would corrupt quota accounting.
 *
 *   - **Stop reasons are normalized to a closed enum**, with `unknown` for values
 *     a provider added that this build does not recognise. An unrecognised stop
 *     reason must not be silently treated as `end_turn`, or a truncated response
 *     looks complete.
 */

import type { FreecodeConfig, ProviderConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A text or image content block, matching the multimodal wire shape. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly dataBase64: string };

export interface TextMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string | readonly ContentBlock[];
}

/** A tool result fed back to the model. */
export interface ToolResultMessage {
  readonly role: 'tool';
  /** Must match the `id` of the `ToolCall` this answers. */
  readonly toolCallId: string;
  readonly content: string;
  /** Whether the tool errored. Some providers need this to render a failure correctly. */
  readonly isError?: boolean;
}

/** An assistant turn that contains tool calls, replayed back to the model. */
export interface AssistantToolCallMessage {
  readonly role: 'assistant';
  readonly content: string | readonly ContentBlock[];
  readonly toolCalls: readonly ToolCall[];
}

export type ChatMessage = TextMessage | ToolResultMessage | AssistantToolCallMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. Must be an object schema. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** A tool call emitted by the model. */
export interface ToolCall {
  /** Provider-assigned id, echoed back with the result. */
  readonly id: string;
  readonly name: string;
  /**
   * Raw JSON string of arguments, exactly as the provider produced it.
   * Empty string is valid and means "no arguments".
   */
  readonly argumentsJson: string;
}

/** How the model should choose tools on this turn. */
export type ToolChoice = 'auto' | 'none' | 'required' | { readonly name: string };

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatRequest {
  /** Model id in the provider's own namespace. */
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  /** Upper bound on generated tokens. */
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  /** Sequences that stop generation. */
  readonly stop?: readonly string[];
  /** Whether to stream. Set by the caller; adapters honour it. */
  readonly stream: boolean;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Provider-specific escape hatch. Applied last so an adapter can honour a
   * documented parameter this build does not model generically.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens served from the provider's prompt cache, when reported. */
  readonly cachedInputTokens?: number;
  /** Tokens used for reasoning, when the provider separates them. */
  readonly reasoningTokens?: number;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'content_filter'
  | 'error'
  /** A stop reason this build does not recognise. Never treated as success. */
  | 'unknown';

/** A completed (non-streamed) response. */
export interface ChatResponse {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: StopReason;
  /** `undefined` when the provider does not report usage. */
  readonly usage?: TokenUsage;
  /** Milliseconds spent on the request, measured by the client. */
  readonly latencyMs: number;
  /** Provider-reported request id, for support escalation. */
  readonly providerRequestId?: string;
}

/** Incremental events emitted while streaming. */
export type StreamEvent =
  | { readonly type: 'start'; readonly id: string; readonly model: string }
  | { readonly type: 'text'; readonly delta: string }
  /** A reasoning/thinking delta, kept separate so it can be hidden by default. */
  | { readonly type: 'reasoning'; readonly delta: string }
  /**
   * A tool call began. `argumentsJson` so far is a fragment and is not
   * necessarily parseable yet.
   */
  | {
      readonly type: 'tool_call_start';
      readonly index: number;
      readonly id: string;
      readonly name: string;
    }
  /** More argument text for a tool call already started at `index`. */
  | { readonly type: 'tool_call_delta'; readonly index: number; readonly delta: string }
  | { readonly type: 'tool_call_end'; readonly index: number; readonly argumentsJson: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | {
      readonly type: 'done';
      readonly stopReason: StopReason;
      readonly usage?: TokenUsage;
      readonly providerRequestId?: string;
    }
  | { readonly type: 'error'; readonly error: Error };

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a model can do.
 *
 * Capabilities are *declared* by the catalogue and *confirmed* by a probe (see
 * `models/discovery.ts`). A capability is never assumed from the model's name:
 * the field name embeds which of the two it is, so a caller cannot confuse a
 * claim with a measurement.
 */
export interface ModelCapabilities {
  /** Whether the model accepts image content blocks. */
  readonly vision: boolean;
  /** Whether the model emits tool calls. */
  readonly toolCalling: boolean;
  /** Whether the API supports streaming for this model. */
  readonly streaming: boolean;
  /** Whether the model can be given a JSON-schema response format. */
  readonly structuredOutput: boolean;
  /** Whether the provider reports token usage for this model. */
  readonly reportsUsage: boolean;
  /** Whether extended reasoning is available and reported separately. */
  readonly reasoning: boolean;
}

/** Capabilities that have actually been observed, with provenance. */
export interface VerifiedCapabilities {
  readonly values: Partial<ModelCapabilities>;
  /** ISO-8601 timestamp of the probe that produced these values. */
  readonly verifiedAt: string;
  /** How the values were obtained. */
  readonly method: 'probe' | 'provider-metadata' | 'declared';
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderInfo {
  /** Stable identifier used in model references and configuration. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Default base URL. Empty when the provider is purely self-hosted. */
  readonly defaultBaseUrl: string;
  /**
   * Environment variables checked, in order, for this provider's API key.
   * Never includes the key itself.
   */
  readonly apiKeyEnvVars: readonly string[];
  /** Whether the provider requires a key at all (Ollama does not). */
  readonly requiresApiKey: boolean;
  /** Documentation URL for the user's own reference. */
  readonly docsUrl?: string;
  /** Terms of service, shown when a provider is added. */
  readonly termsUrl?: string;
}

export interface ProviderHealth {
  readonly healthy: boolean;
  /** Milliseconds for the most recent successful request. */
  readonly latencyMs?: number;
  readonly checkedAt: string;
  /** Consecutive failures; drives the circuit breaker. */
  readonly consecutiveFailures: number;
  readonly lastError?: string;
}

/** Options an adapter receives at construction. */
export interface ProviderContext {
  readonly config: ProviderConfig;
  /** Fully-resolved API key, or undefined when the provider needs none. */
  readonly apiKey: string | undefined;
  /** Resolved base URL (config override or the adapter's default). */
  readonly baseUrl: string;
  /** Full application config, for cross-cutting policy (timeouts, redirects). */
  readonly appConfig: FreecodeConfig;
  /** Emits redacted diagnostics. */
  readonly log: Logger;
}

/**
 * The provider interface.
 *
 * Deliberately small: four methods. Anything a single provider needs beyond this
 * belongs in that adapter, not in the shared contract.
 */
export interface Provider {
  readonly info: ProviderInfo;
  /** The resolved base URL in use, for display and diagnostics. */
  readonly baseUrl: string;

  /**
   * List models this credential can actually reach.
   *
   * Returned ids are in the provider's own namespace. An adapter that cannot
   * enumerate (many OpenAI-compatible servers cannot) returns an empty array
   * rather than a hard-coded list — inventing model ids is exactly the failure
   * mode this project forbids.
   */
  listModels(signal?: AbortSignal): Promise<ModelDescriptor[]>;

  /** One non-streaming completion. */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /** One streaming completion. The generator ends after a `done` or `error` event. */
  stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined>;

  /**
   * A cheap reachability check.
   *
   * Must not spend meaningful tokens: a `listModels` call, or a one-token
   * completion at most. Used by `models test` and the discovery sweep.
   */
  checkHealth(signal?: AbortSignal): Promise<ProviderHealth>;
}

/** A model as the provider describes it. */
export interface ModelDescriptor {
  readonly id: string;
  readonly providerId: string;
  /** Display name when the provider supplies one distinct from the id. */
  readonly displayName?: string;
  /** Context window, only when the provider states it. Never guessed. */
  readonly contextWindow?: number;
  readonly capabilities?: Partial<ModelCapabilities>;
  /** Unix epoch ms the provider reports for creation, when available. */
  readonly createdAt?: number;
}

/** Thrown by an adapter when it cannot support an operation at all. */
export class UnsupportedOperationError extends Error {
  constructor(operation: string, providerId: string) {
    super(`Provider “${providerId}” does not support ${operation}.`);
    this.name = 'UnsupportedOperationError';
  }
}
