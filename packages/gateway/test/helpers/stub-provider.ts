/**
 * A scriptable `Provider` for gateway tests.
 *
 * It implements the real interface — `chat`, `stream`, `listModels`,
 * `checkHealth` — so the gateway's own code paths (normalization, quota, usage
 * recording, SSE framing) are exercised exactly as they would be against a live
 * upstream. Only the network boundary is replaced, which is the one thing a test
 * should never depend on.
 */

import type {
  ChatRequest,
  ChatResponse,
  ModelDescriptor,
  Provider,
  ProviderHealth,
  ProviderInfo,
  StreamEvent,
  TokenUsage,
} from '@freecode/core';

export interface StubProviderOptions {
  readonly id?: string;
  /** Reply to a non-streaming request. Defaults to an echo. */
  readonly respond?: (request: ChatRequest) => Promise<ChatResponse> | ChatResponse;
  /** Emit a streaming response. Defaults to a two-token answer. */
  readonly stream?: (request: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined>;
}

export const STUB_USAGE: TokenUsage = { inputTokens: 11, outputTokens: 7 };

export class StubProvider implements Provider {
  readonly info: ProviderInfo;
  readonly baseUrl = 'https://stub.invalid/v1';
  /** Every request the gateway sent, in order — the assertion surface. */
  readonly requests: ChatRequest[] = [];
  #respond: (request: ChatRequest) => Promise<ChatResponse> | ChatResponse;
  #stream: (request: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined>;

  constructor(options: StubProviderOptions = {}) {
    const id = options.id ?? 'fake';
    this.info = {
      id,
      name: id,
      defaultBaseUrl: this.baseUrl,
      apiKeyEnvVars: [],
      requiresApiKey: false,
    };
    this.#respond = options.respond ?? ((request) => defaultResponse(request));
    this.#stream = options.stream ?? ((request) => defaultStream(request));
  }

  setResponder(fn: (request: ChatRequest) => Promise<ChatResponse> | ChatResponse): void {
    this.#respond = fn;
  }

  setStreamer(fn: (request: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined>): void {
    this.#stream = fn;
  }

  listModels(): Promise<ModelDescriptor[]> {
    return Promise.resolve([]);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    return this.#respond(request);
  }

  stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.requests.push(request);
    return this.#stream(request);
  }

  checkHealth(): Promise<ProviderHealth> {
    return Promise.resolve({
      healthy: true,
      checkedAt: new Date(0).toISOString(),
      consecutiveFailures: 0,
    });
  }
}

function defaultResponse(request: ChatRequest): ChatResponse {
  return {
    id: 'stub-1',
    model: request.model,
    content: 'stub answer',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: STUB_USAGE,
    latencyMs: 1,
  };
}

async function* defaultStream(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
  yield { type: 'start', id: 'stub-1', model: request.model };
  yield { type: 'text', delta: 'stub ' };
  yield { type: 'text', delta: 'answer' };
  yield { type: 'usage', usage: STUB_USAGE };
  yield { type: 'done', stopReason: 'end_turn', usage: STUB_USAGE };
}

/** A stream that emits the given texts and then finishes. */
export function textStream(
  texts: readonly string[],
  usage?: TokenUsage,
): (request: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined> {
  return async function* (request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    yield { type: 'start', id: 'stub-1', model: request.model };
    for (const text of texts) yield { type: 'text', delta: text };
    if (usage !== undefined) yield { type: 'usage', usage };
    yield { type: 'done', stopReason: 'end_turn', ...(usage === undefined ? {} : { usage }) };
  };
}

/** A stream that emits tool-call fragments, then finishes with `tool_use`. */
export function toolCallStream(
  name: string,
  argsFragments: readonly string[],
): (request: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined> {
  return async function* (request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    yield { type: 'start', id: 'stub-1', model: request.model };
    yield { type: 'tool_call_start', index: 0, id: 'call_1', name };
    for (const fragment of argsFragments) {
      yield { type: 'tool_call_delta', index: 0, delta: fragment };
    }
    yield { type: 'tool_call_end', index: 0, argumentsJson: argsFragments.join('') };
    yield { type: 'done', stopReason: 'tool_use' };
  };
}
