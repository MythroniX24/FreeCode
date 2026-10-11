/**
 * A local HTTP server for exercising provider adapters.
 *
 * Adapters are tested against a real socket rather than a stubbed `fetch`, for
 * two reasons:
 *
 *  - The transport's security behaviour *is* the thing under test. The SSRF
 *    guard, the manual redirect loop, the byte cap and the header handling only
 *    exist in the interaction with a server; a stubbed `fetch` would assert that
 *    the code calls the stub, not that it is safe.
 *  - Streaming bugs live in chunk boundaries, and a real server can be made to
 *    flush at chosen points. A stub that hands back one complete body cannot
 *    reproduce the fragmentation that breaks naive SSE parsers.
 *
 * The server binds to 127.0.0.1, which the SSRF guard permits as an explicitly
 * allowed loopback host — the same path a user's local Ollama install takes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export type Handler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>;

export interface TestServer {
  /** Base URL, e.g. `http://127.0.0.1:41234`. */
  readonly url: string;
  readonly port: number;
  /** Every request received, in order. */
  readonly requests: RecordedRequest[];
  /** Replace the handler mid-test, e.g. to fail a retry then succeed. */
  setHandler(handler: Handler): void;
  close(): Promise<void>;
}

/** Start a server that defers to `handler` for every request. */
export async function startTestServer(handler: Handler): Promise<TestServer> {
  let current = handler;
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);

      Promise.resolve(current(recorded, res)).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
        }
        res.end(`handler error: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    setHandler(next: Handler) {
      current = next;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Respond with JSON. */
export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

/**
 * Respond with an SSE stream.
 *
 * `chunks` are written as separate `write()` calls with an await between them,
 * so the client receives them as distinct TCP segments. That is what makes the
 * fragmentation real rather than theoretical.
 */
export async function sse(
  res: ServerResponse,
  chunks: readonly string[],
  options: { status?: number; delayMs?: number } = {},
): Promise<void> {
  res.writeHead(options.status ?? 200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  for (const chunk of chunks) {
    res.write(chunk);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }
  res.end();
}

/** Wrap a JSON object as one SSE `data:` event. */
export function sseData(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * A minimal OpenAI-compatible chat-completion chunk.
 *
 * Returned as a concrete record rather than `unknown` so a test can spread it to
 * add a field — which is how the "usage arrives on the final chunk" case is built.
 */
export function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** A minimal OpenAI-compatible non-streaming completion. */
export function chatCompletion(options: {
  content?: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: unknown;
}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: options.content ?? null,
          ...(options.toolCalls === undefined ? {} : { tool_calls: options.toolCalls }),
        },
        finish_reason: options.finishReason ?? 'stop',
      },
    ],
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}
