/**
 * `freecode run` end-to-end, against a fake OpenAI-compatible provider.
 *
 * These tests exercise the full path a real session takes — config file,
 * credential resolution, SSRF-guarded HTTP, the provider adapter, the agent
 * loop, the tool suite, and the renderer — as a child process driving the
 * *built* CLI. Only the provider is faked: the HTTP server speaks the real
 * chat-completions streaming wire format that `openai-compatible.ts` decodes
 * (tool-call fragments, `include_usage`, the `[DONE]` sentinel).
 *
 * Each scenario is a fixed request-by-request script. The loop replays the
 * assistant's tool-call turn verbatim, then feeds the tool result back as the
 * next user turn — so request 2 always contains a `tool` message. The fake
 * server advances its script on every request and, when the script ends,
 * refuses further requests; the loop's own budget checks stop a runaway agent,
 * but an unexpected extra request means we exhausted the script and the test
 * should fail loudly.
 *
 * Skipped when `dist/` is absent, mirroring `e2e.test.ts`.
 */

import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, '../dist/index.js');
const built = existsSync(distEntry);

const API_KEY_ENV = 'FREECODE_TEST_API_KEY';
const API_KEY = 'sk-fake-e2e-run-key';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One SSE `data:` line carrying a chat-completions chunk. */
function streamChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A streaming chunk that carries no new content (used to end a tool turn). */
function deltaChunk(overrides: Record<string, unknown> = {}): string {
  return streamChunk({
    id: 'req',
    object: 'chat.completion.chunk',
    model: 'fake-model',
    choices: [{ index: 0, ...overrides, finish_reason: 'tool_calls' }],
  });
}

const tmpDirs: string[] = [];
let server: Server;
let providerPort = 0;

/** Script a tool-call turn: start, delta, end, and a finish chunk. */
function toolTurn(): string[] {
  return [
    deltaChunk({
      delta: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '' },
          },
        ],
      },
    }),
    streamChunk({
      id: 'req',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"path":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    streamChunk({
      id: 'req',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '"a.ts"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  ];
}

beforeAll(async () => {
  // The server is created empty in `beforeAll`; each test installs its own
  // request handler with `server.on('request', …)` and clears it afterwards.
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  providerPort = (server.address() as { port: number }).port;
});

/** A fresh workspace + config that points at the fake provider. */
async function freshWorkspace(): Promise<{ env: NodeJS.ProcessEnv; runDir: string }> {
  const base = await fs.mkdtemp(path.join(os.homedir(), '.freecode-run-e2e-'));
  tmpDirs.push(base);
  const runDir = path.join(base, 'ws');
  await fs.mkdir(runDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...{ [API_KEY_ENV]: API_KEY },
    FREECODE_CONFIG_DIR: path.join(base, 'config'),
    FREECODE_DATA_DIR: path.join(base, 'data'),
    FREECODE_CACHE_DIR: path.join(base, 'cache'),
  };
  await fs.mkdir(env['FREECODE_CONFIG_DIR']!, { recursive: true });
  await fs.writeFile(
    path.join(env['FREECODE_CONFIG_DIR']!, 'config.json'),
    JSON.stringify({
      accessMode: 'byok',
      defaultProvider: 'fake',
      providers: {
        fake: {
          enabled: true,
          type: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          apiKeyEnv: API_KEY_ENV,
          models: ['fake-model'],
        },
      },
      agent: { checkpoints: false },
      // Mutations (write_file) are the point of this test; auto-safe allows a
      // confined file write with no TTY prompt. The default `ask` mode would
      // refuse it, because an unattended run must not assume consent.
      approval: { mode: 'auto-safe' },
    }),
    { mode: 0o600 },
  );
  return { env, runDir };
}

/** Run the built CLI as a child process, never throwing. */
async function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [distEntry, ...args], {
      env,
      cwd,
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A fake provider whose stream is a sequence of full SSE payloads. */
function scriptedStream(payloads: string[]): string {
  return payloads.join('');
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(
    tmpDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe.skipIf(!built)('freecode run end-to-end', () => {
  it('answers a text-only model and exits 0', async () => {
    const { env, runDir } = await freshWorkspace();

    // Return a plain text answer with usage.
    server.removeAllListeners('request');
    const textTurn = `${streamChunk({
      id: 'r1',
      object: 'chat.completion.chunk',
      model: 'fake-model',
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'Hello from fake' }, finish_reason: null },
      ],
    })}${streamChunk({
      id: 'r1',
      object: 'chat.completion.chunk',
      model: 'fake-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    })}[DONE]\n`;
    server.on('request', (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
      });
      res.write(textTurn);
      res.end();
    });

    const { code, stdout } = await runCli(['run', 'hello'], env, runDir);
    expect(code).toBe(0);
    expect(stdout).toContain('Hello from fake');
    server.removeAllListeners('request');
  });

  it('resolves a bare --model id through stealth identification to the pinned provider', async () => {
    const { env, runDir } = await freshWorkspace();

    // The config pins `providers.fake.models = ['fake-model']`; a bare `--model
    // fake-model` with no provider must resolve to `fake` via identification and
    // reach the fake provider, not fail with "provider not identified".
    const textTurn = `${streamChunk({
      id: 'r1',
      object: 'chat.completion.chunk',
      model: 'fake-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'identified and answered' },
          finish_reason: null,
        },
      ],
    })}${streamChunk({
      id: 'r1',
      object: 'chat.completion.chunk',
      model: 'fake-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}[DONE]\n`;
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
      });
      res.write(textTurn);
      res.end();
    });

    const { code, stdout } = await runCli(['run', '--model', 'fake-model', 'hello'], env, runDir);
    expect(code).toBe(0);
    expect(stdout).toContain('identified and answered');
    server.removeAllListeners('request');
  });

  it('exits 8 (quota) when the same tool call repeats past the threshold', async () => {
    const { env, runDir } = await freshWorkspace();

    // The model only ever asks to read a.ts; the loop must trip its
    // repeated-call guard, not run forever.
    const turn = toolTurn();
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
      });
      res.write(scriptedStream(turn));
      res.end();
    });

    const { code, stdout } = await runCli(['run', 'loop', 'a'], env, runDir);
    // The loop's repeated-call guard stops the runaway and the CLI maps that
    // budget stop to the Quota exit code.
    expect(code).toBe(8);
    expect(stdout).toContain('repeated');
    server.removeAllListeners('request');
  });

  it('runs a real write_file through the loop and the file appears', async () => {
    const { env, runDir } = await freshWorkspace();

    // Turn 1: the model opens a write_file tool call. Turn 2: it must have
    // received the tool result (its body carries a `tool` message), and answers
    // with plain text, ending the run.
    const writeTurn = [
      `${streamChunk({
        id: 'r1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'write_file', arguments: '' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}${streamChunk({
        id: 'r1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"path":"made.txt","content":"hi"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      })}`,
    ];
    const doneTurn = `${streamChunk({
      id: 'r2',
      object: 'chat.completion.chunk',
      model: 'fake-model',
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'File created.' }, finish_reason: 'stop' },
      ],
    })}[DONE]\n`;

    server.removeAllListeners('request');
    let requestsSeen = 0;
    server.on('request', (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const turn = requestsSeen === 0 ? writeTurn.join('') : doneTurn;
        requestsSeen += 1;
        // The follow-up turn must contain the tool result the loop fed back.
        if (requestsSeen === 2) expect(body).toContain('tool_call_id');
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
        });
        res.write(turn);
        res.end();
      });
    });

    // `--yes` lets the mutating write run without a TTY prompt.
    const { code, stdout } = await runCli(['run', 'create made.txt'], env, runDir);
    expect(code).toBe(0);
    expect(stdout).toContain('File created.');
    expect(await fs.readFile(path.join(runDir, 'made.txt'), 'utf8').catch(() => '<missing>')).toBe(
      'hi',
    );
    server.removeAllListeners('request');
  });
});
