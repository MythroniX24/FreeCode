/**
 * The Fastify application.
 *
 * Built as a function returning an instance rather than a module-level singleton,
 * so a test can stand up a gateway with a memory store and a fake provider in
 * one call, and so two gateways could run in one process (a canary, a blue/green
 * pair) without interfering through module state.
 *
 * **A note on the handler style.** Every route handler here operates on typed
 * request/response objects rather than relying on Fastify's inference. That is
 * deliberate: the gateway's request and response shapes are the OpenAI wire
 * format, whose optionality is genuinely awkward to express through the decorator
 * system, and hand-writing the boundary is what keeps the wire types identical
 * between the streaming and non-streaming paths.
 *
 * **Streaming is manual.** `hijack()` hands the socket to the generator, which
 * writes each SSE frame itself. The alternative — Fastify's `reply.send` with a
 * stream — would buffer under backpressure and make the mid-stream error frame
 * (which is the only way to report a late upstream failure, since the status line
 * is long gone) impossible to place correctly.
 *
 * **The CSRF/body-parser surface is deliberately empty.** The gateway serves
 * JSON APIs to header-authenticated clients and renders nothing, so there is no
 * content-type parsing to confuse, no form to post, and no method-override
 * header to honour. `maxParamLength` is bounded so a pathological path cannot
 * allocate unboundedly.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { FreecodeError } from '@freecode/core';

import type { GatewayConfig } from '../config.js';
import { Authenticator, type Principal } from './auth.js';
import { handleChatCompletion } from './routes/chat.js';
import { handleHealth, handleModelRetrieve, handleModelsList } from './routes/models.js';
import { handleUsage } from './routes/usage.js';
import {
  badRequest,
  fromFreecodeError,
  internalError,
  isGatewayHttpError,
  unauthorized,
  type GatewayHttpError,
} from './errors.js';
import type { RouteDeps } from './deps.js';

export interface BuildAppOptions {
  /**
   * Everything the routes need, including the redacting logger. The logger is
   * not a separate option: `deps.log` is the one instance the whole gateway
   * shares, and threading a second one here would invite the two to diverge.
   */
  readonly deps: RouteDeps;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { deps } = options;
  const config: GatewayConfig = deps.config;

  const app = Fastify({
    // The gateway logs through core's redacting `Logger`, not Fastify's own, so
    // that no request detail can reach a sink without passing the redactor.
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    // A bounded path length keeps a pathological URL from allocating
    // unboundedly; the option now lives under `routerOptions`.
    routerOptions: { maxParamLength: 256 },
  });

  app.addHook('onRequest', (request, reply, done) => {
    // A cheap correlation id, echoed so a caller can quote it in a support
    // request. `request.id` is Fastify's own.
    reply.header('x-request-id', String(request.id));
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = error instanceof Error ? error : new Error(String(error));
    void handleFailure(request, reply, mapped, deps);
  });

  app.setNotFoundHandler((request, reply) => {
    void sendError(
      reply,
      404,
      badRequest(`No route for ${request.method} ${request.url}.`, {
        code: 'not_found',
      }),
    );
  });

  registerRoutes(app, deps);
  return app;
}

function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/health', async (_request, reply) => {
    const { status, body } = handleHealth(deps);
    await reply.code(status).send(body);
  });

  app.get('/v1/models', async (request, reply) => {
    // `authenticate` throws the 401 itself when the key is bad; a `false` return
    // only happens after a successful reply, so `await` here is what guarantees
    // the error response has actually been sent before the include aborts.
    const principal = await authenticate(deps, request, reply);
    if (principal === undefined) return;
    const { status, body } = handleModelsList(deps);
    await reply.code(status).send(body);
  });

  // A wildcard, not `:id`: model references contain a slash (`provider/model`),
  // and Fastify's `:id` matches a single path segment. Matching the remainder of
  // the path is what lets `GET /v1/models/fake/test-model` resolve.
  app.get('/v1/models/*', async (request, reply) => {
    const principal = await authenticate(deps, request, reply);
    if (principal === undefined) return;
    const raw = (request.params as { '*': string })['*'] ?? '';
    const id = raw
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    const { status, body } = handleModelRetrieve(deps, id);
    await reply.code(status).send(body);
  });

  app.get('/v1/usage', async (request, reply) => {
    const principal = await authenticate(deps, request, reply);
    if (principal === undefined) return;
    const limit = clampLimit((request.query as { limit?: string }).limit);
    const { status, body } = await handleUsage(deps, principal, limit);
    await reply.code(status).send(body);
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const principal = await authenticate(deps, request, reply);
    if (principal === undefined) return;

    // The client aborting must abort the upstream generation. `request.raw` is
    // the Node stream; `reply.raw` is the outbound one. Both are observed: a
    // client disconnect closes the former, and a gateway shutdown or an
    // internal error closes the latter.
    const controller = new AbortController();
    const onClose = () => controller.abort();
    request.raw.on('aborted', onClose);
    reply.raw.on('close', () => {
      // Only abort when the response did not finish normally; a normal finish
      // also fires `close`.
      if (!reply.raw.writableFinished) controller.abort();
    });

    const result = await handleChatCompletion(deps, {
      body: request.body,
      principal,
      signal: controller.signal,
    });

    if ('stream' in result) {
      return streamReply(reply, result.stream, deps);
    }

    request.raw.off('aborted', onClose);
    await reply.code(result.status).send(result.body);
    return reply;
  });
}

/**
 * Authenticate a request.
 *
 * Returns the principal, or `undefined` **after having sent the 401** — the await
 * on the write is what makes "we replied already" true by the time the caller
 * checks the return value, which is the mistake this pattern exists to prevent.
 */
async function authenticate(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Principal | undefined> {
  const key = Authenticator.keyFromHeaders(
    request.headers as Record<string, string | string[] | undefined>,
  );
  const result = deps.authenticator.authenticate(key);
  if (result.ok) return result.principal;

  await sendError(
    reply,
    401,
    unauthorized(
      result.reason === 'missing'
        ? 'Missing API key. Send it as “Authorization: Bearer <key>”.'
        : 'The API key is not valid.',
    ),
  );
  return undefined;
}

/** Write a streaming response, hijacking the socket for the generator. */
async function streamReply(
  reply: FastifyReply,
  stream: AsyncGenerator<string, void, undefined>,
  deps: RouteDeps,
): Promise<FastifyReply> {
  // Hijacking bypasses Fastify's own lifecycle so nothing rewrites the body.
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Defeat proxy buffering, which otherwise turns a token stream into a
    // single delayed blob on several common reverse proxies.
    'x-accel-buffering': 'no',
  });

  try {
    for await (const frame of stream) {
      if (raw.writableEnded) break;
      raw.write(frame);
    }
  } catch (error) {
    deps.log.error('stream failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (!raw.writableEnded) raw.end();
  }
  return reply;
}

/** Map any thrown value onto an HTTP error and send it, without leaking. */
async function handleFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  deps: RouteDeps,
): Promise<void> {
  if (isGatewayHttpError(error)) {
    await sendError(reply, error.status, error);
    return;
  }

  // A core `FreecodeError` — most importantly the `QuotaError` raised when a
  // model is gated for being non-free — carries its own meaning. Mapping it here
  // is what turns "this gateway serves free models only" into a `429
  // insufficient_quota` rather than a generic 500.
  if (error instanceof FreecodeError) {
    const mapped = fromFreecodeError(error);
    await sendError(reply, mapped.status, mapped);
    return;
  }

  // Fastify's own body-parser and validation errors carry a `statusCode`; honour
  // it as a 400 rather than masking a client mistake as a server bug.
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    await sendError(
      reply,
      statusCode,
      badRequest(error instanceof Error ? error.message : 'Invalid request.', {
        code: 'invalid_request',
      }),
    );
    return;
  }

  deps.log.error('unhandled gateway error', {
    method: request.method,
    url: request.url,
    reason: error instanceof Error ? error.message : String(error),
  });
  await sendError(reply, 500, internalError(error));
}

/** Serialize a `GatewayHttpError` (or a bare one) as an OpenAI-shaped body. */
async function sendError(
  reply: FastifyReply,
  status: number,
  error: GatewayHttpError,
): Promise<void> {
  if (reply.sent) return;
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
  await reply.code(status).send(error.toBody());
}

function clampLimit(raw: string | undefined): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 100);
}
