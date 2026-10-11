/**
 * `POST /v1/chat/completions` — the one endpoint that spends money.
 *
 * The order of operations is the security-relevant part, and each step exists
 * because skipping it is a real failure:
 *
 *   1. **Authenticate.** Identify the principal before anything else, so an
 *      unauthenticated caller cannot probe the catalogue or the upstreams.
 *   2. **Resolve the model.** An unknown or gated model is refused here, before
 *      a slot is taken and before any upstream is contacted.
 *   3. **Check the quota.** Every window, against the ledger — the server, not
 *      the client, decides what a principal may consume.
 *   4. **Take a concurrency slot.** Only now is an upstream contacted.
 *   5. **Record the usage.** After the request finishes, with the provider's own
 *      counts (or zeros when it reported none — never a guess).
 *
 * For a streamed request, a client disconnect mid-stream ends the generation:
 * continuing to pay for tokens nobody will read is precisely the waste a hosted
 * gateway must not indulge. The partial usage is still recorded, marked with a
 * `499`, so the ledger reflects what was actually spent.
 */

import { QuotaError, redact, type ChatRequest, type TokenUsage } from '@freecode/core';

import type { CatalogueEntry } from '../../upstream/catalogue.js';
import { costOf, finishReasonOf, type RouteDeps } from '../deps.js';
import { badRequest, notFound, quotaError, serviceUnavailable, upstreamError } from '../errors.js';
import type { Principal } from '../auth.js';
import {
  chatRequestSchema,
  chunkFinish,
  chunkRole,
  chunkText,
  chunkToolCallArgs,
  chunkToolCallStart,
  completionId,
  normalizeChatRequest,
  sseComment,
  sseDoneFrame,
  sseFrame,
  wireUsage,
} from '../wire.js';

export interface ChatHandlerInput {
  readonly body: unknown;
  readonly principal: Principal;
  readonly signal: AbortSignal;
  /** Called once a streaming response has begun writing. */
  readonly onStreamStart?: () => void;
}

export interface NonStreamingResult {
  readonly status: number;
  readonly body: unknown;
}

export interface StreamingResult {
  readonly stream: AsyncGenerator<string, void, undefined>;
}

/**
 * Decide whether this principal and model may proceed, and return the catalogue
 * entry. Throws a `GatewayHttpError` on any refusal.
 */
async function authorize(
  deps: RouteDeps,
  body: unknown,
  _principal: Principal,
): Promise<{ entry: CatalogueEntry; request: ReturnType<typeof normalizeChatRequest> }> {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const param = issue?.path.map(String).join('.');
    throw badRequest(
      `Invalid request body: ${param ?? ''} ${issue?.message ?? 'unrecognised'}.`,
      param === undefined || param === '' ? {} : { param },
    );
  }

  const request = normalizeChatRequest(parsed.data);

  const requested = request.model ?? '';
  const entry = requested === '' ? deps.catalogue.defaultEntry : deps.catalogue.resolve(requested);

  if (entry === undefined) {
    // Name what *is* served: a 404 that lists the alternatives is answerable
    // without a second round trip to `GET /v1/models`.
    const available = deps.catalogue.entries
      .map((e) => e.reference)
      .sort()
      .slice(0, 20)
      .join(', ');
    throw notFound(
      requested === ''
        ? 'The gateway has no default model configured.'
        : `The gateway does not serve model “${requested}”. Available: ${available || '(none)'}.`,
      requested === '' ? 'no_default_model' : 'model_not_found',
    );
  }

  if (entry.billing !== 'free') {
    if (!deps.config.enforcePaidModels) {
      throw new QuotaError(
        `Model “${entry.reference}” is billed as “${entry.billing}”, and this gateway is configured for free models only.`,
        {
          details: { model: entry.reference, billing: entry.billing },
          hint: 'The operator can enable paid models with GATEWAY_ALLOW_PAID_MODELS=true.',
        },
      );
    }
  }

  return { entry, request };
}

export async function handleChatCompletion(
  deps: RouteDeps,
  input: ChatHandlerInput,
): Promise<NonStreamingResult | StreamingResult> {
  const { entry, request } = await authorize(deps, input.body, input.principal);

  // Quota: every window, before a slot or an upstream is touched.
  const decision = await deps.limiter.check(input.principal.id);
  if (!decision.allowed) {
    throw quotaError(
      decision.code ?? 'quota_exceeded',
      decision.message ?? 'Quota exceeded.',
      decision.details ?? {},
    );
  }

  // Resolve the upstream now, so an unavailable provider is a clean 502 before a
  // response has started — rather than an in-band error frame later.
  await deps.resolver.get(entry.providerId).catch((error: unknown) => {
    throw serviceUnavailable(
      `Upstream provider “${entry.providerId}” is unavailable.`,
      'provider_unavailable',
      error,
    );
  });

  const chatRequest: ChatRequest = {
    model: entry.model,
    messages: request.messages,
    ...(request.tools.length === 0 ? {} : { tools: request.tools }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    stream: request.stream,
    timeoutMs: deps.config.upstreamTimeoutMs,
    signal: input.signal,
  };

  if (request.stream) {
    return {
      stream: streamCompletion(deps, entry, chatRequest, input),
    };
  }
  return nonStreaming(deps, entry, chatRequest, input);
}

async function nonStreaming(
  deps: RouteDeps,
  entry: CatalogueEntry,
  request: ChatRequest,
  input: ChatHandlerInput,
): Promise<NonStreamingResult> {
  const startedAt = Date.now();
  try {
    const response = await deps.limiter.run(
      () => deps.resolver.get(entry.providerId).then((provider) => provider.chat(request)),
      { timeoutMs: deps.config.upstreamTimeoutMs + 10_000 },
    );

    const usage = response.usage;
    await recordUsage(deps, entry, input.principal, usage, Date.now() - startedAt, 200);

    return {
      status: 200,
      body: {
        id: completionId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: entry.reference,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: response.content === '' ? null : response.content,
              ...(response.toolCalls.length === 0
                ? {}
                : {
                    tool_calls: response.toolCalls.map((call) => ({
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: call.argumentsJson },
                    })),
                  }),
            },
            finish_reason: finishReasonOf(response.stopReason),
          },
        ],
        usage: wireUsage(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0),
      },
    };
  } catch (error) {
    throw upstreamError(error, `Upstream “${entry.providerId}” failed`);
  }
}

/**
 * Stream a completion as SSE.
 *
 * The generator owns recording: it is the only place that knows the final usage
 * and whether the client left, so the ledger entry is written exactly once, in
 * the generator's `finally`, whatever path the stream takes.
 */
async function* streamCompletion(
  deps: RouteDeps,
  entry: CatalogueEntry,
  request: ChatRequest,
  input: ChatHandlerInput,
): AsyncGenerator<string, void, undefined> {
  const startedAt = Date.now();
  const id = completionId();
  let usage: TokenUsage | undefined;
  let stopReason = 'stop';
  let status = 200;
  // The concurrency slot is held for the *whole* stream, not just the first
  // byte. Released in the `finally` below, on every exit path.
  const release = await deps.limiter.hold({ timeoutMs: deps.config.upstreamTimeoutMs + 10_000 });

  try {
    input.onStreamStart?.();
    // An opening comment frame. `: …` is a legal SSE comment, so every client
    // (including the core's own parser) ignores it — but it flushes the response
    // headers immediately, so a slow first token does not look like a hang to a
    // caller that is waiting for the connection to establish.
    yield sseComment('freecode-gateway');
    yield sseFrame(chunkRole(id, entry.reference));

    const provider = await deps.resolver.get(entry.providerId);
    const generator = provider.stream(request);

    for await (const event of generator) {
      if (input.signal.aborted) {
        status = 499;
        break;
      }
      switch (event.type) {
        case 'text':
          yield sseFrame(chunkText(id, entry.reference, event.delta));
          break;
        case 'tool_call_start':
          yield sseFrame(
            chunkToolCallStart(id, entry.reference, event.index, event.id, event.name),
          );
          break;
        case 'tool_call_delta':
          yield sseFrame(chunkToolCallArgs(id, entry.reference, event.index, event.delta));
          break;
        case 'reasoning':
          // Reasoning deltas are not part of the chat-completions contract the
          // client expects; they are dropped rather than smuggled into content.
          break;
        case 'usage':
          usage = event.usage;
          break;
        case 'done':
          usage = event.usage ?? usage;
          stopReason = finishReasonOf(event.stopReason);
          break;
        case 'error':
          status = 502;
          // The stream has already started; the error is delivered in-band as a
          // final frame, since an HTTP status can no longer be sent.
          yield sseFrame({
            error: {
              message: 'Upstream stream failed.',
              type: 'api_error',
              code: 'upstream_error',
            },
          });
          break;
        default:
          break;
      }
    }

    if (status === 200) {
      yield sseFrame(
        chunkFinish(
          id,
          entry.reference,
          stopReason,
          request.stream ? wireUsage(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0) : undefined,
        ),
      );
      yield sseDoneFrame();
    }
  } catch (error) {
    status = 502;
    // Delivered in-band: headers are long gone by the time an upstream fails
    // mid-stream, so the only honest channel left is a final error frame. The
    // message is redacted for the same reason the non-streaming path's is: an
    // upstream that echoes the request must not leak a key through the frame.
    yield sseFrame({
      error: {
        message: redact(error instanceof Error ? error.message : 'Upstream stream failed.'),
        type: 'api_error',
        code: 'upstream_error',
      },
    });
  } finally {
    release();
    await recordUsage(deps, entry, input.principal, usage, Date.now() - startedAt, status);
  }
}

/** Write one ledger row and one log line for a finished request. */
async function recordUsage(
  deps: RouteDeps,
  entry: CatalogueEntry,
  principal: Principal,
  usage: TokenUsage | undefined,
  latencyMs: number,
  status: number,
): Promise<void> {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const costUsd = costOf(entry, inputTokens, outputTokens);

  deps.log.info('completion', {
    principal: principal.id,
    model: entry.reference,
    provider: entry.providerId,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    status,
  });

  try {
    await deps.store.record({
      principalId: principal.id,
      model: entry.reference,
      providerId: entry.providerId,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      status,
    });
  } catch (error) {
    // A ledger write failure must not break a response the caller already
    // received; it is logged loudly because it means quota accounting is now
    // under-counting.
    deps.log.error('failed to record usage', {
      principal: principal.id,
      model: entry.reference,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
