/**
 * End-to-end CLI tests: the built binary driven as a real child process.
 *
 * These exist because two defects reached the terminal while every unit test
 * was green, and both were only observable *outside* the process:
 *
 *  1. `doctor` reported every provider as "not configured" because its action
 *     was wired without a `CliContext`. A unit test calling `runDoctor(ctx)`
 *     passes regardless — the bug lived in the wiring, not the function.
 *  2. A rejected command promise escaped as an *unhandled rejection* (the
 *     entrypoint used `program.parse`, which does not await async actions), so
 *     the terminal showed a raw Node stack trace instead of the redacted error
 *     the entrypoint is meant to print.
 *
 * Asserting on the child's stdout/stderr/exit code is the only layer that
 * catches that class of bug. Skips (rather than fails) when `dist/` is absent,
 * so a bare `vitest run` without a preceding build does not report false reds.
 */

import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, '../dist/index.js');
const built = existsSync(distEntry);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const tmpDirs: string[] = [];

async function freshEnv(): Promise<NodeJS.ProcessEnv> {
  const base = await fs.mkdtemp(path.join(os.homedir(), '.freecode-e2e-'));
  tmpDirs.push(base);
  return {
    ...process.env,
    FREECODE_CONFIG_DIR: path.join(base, 'config'),
    FREECODE_DATA_DIR: path.join(base, 'data'),
    FREECODE_CACHE_DIR: path.join(base, 'cache'),
  };
}

/** Run the built CLI and capture its streams and exit code, never throwing. */
async function runCli(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [distEntry, ...args], {
      env,
      timeout: 20_000,
      ...(stdin === undefined ? {} : { input: stdin }),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

afterAll(async () => {
  await Promise.all(
    tmpDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe.skipIf(!built)('cli end-to-end', () => {
  it('doctor reports provider status without a stack trace (wiring is live)', async () => {
    const env = await freshEnv();
    const { code, stdout, stderr } = await runCli(['doctor'], env);
    expect(code).toBe(0);
    expect(stdout).toContain('not configured');
    expect(stderr).not.toMatch(/\n\s+at .*\.js:\d+/);
  });

  it('prints a clean redacted error, not a raw stack trace, on a bad config path', async () => {
    const env = await freshEnv();
    const { code, stderr } = await runCli(['config', 'get', 'providers.groq.nope'], env);
    expect(code).toBe(2);
    expect(stderr).toContain('No such config path');
    // The regression: an unhandled rejection prints `UsageError: …` plus a
    // `at …/config.js:NN` stack. Neither may appear.
    expect(stderr).not.toMatch(/UsageError:/);
    expect(stderr).not.toMatch(/\n\s+at .*:\d+:\d+/);
  });

  it('exit codes a failed model refresh as 1 with a per-provider ✗ line', async () => {
    const env = await freshEnv();
    // A loopback base URL on a closed port fails fast and deterministically —
    // no external network, no flakiness.
    await fs.mkdir(env['FREECODE_CONFIG_DIR']!, { recursive: true });
    await fs.writeFile(
      path.join(env['FREECODE_CONFIG_DIR']!, 'config.json'),
      JSON.stringify({
        accessMode: 'byok',
        providers: {
          groq: { enabled: true, type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' },
        },
      }),
      { mode: 0o600 },
    );
    const { code, stdout } = await runCli(['models', 'refresh'], env);
    expect(code).toBe(1);
    expect(stdout).toContain('✗ groq:');
  });

  it('models which resolves a bare id via a config pin and stays silent rather than guessing', async () => {
    const env = await freshEnv();
    await fs.mkdir(env['FREECODE_CONFIG_DIR']!, { recursive: true });
    await fs.writeFile(
      path.join(env['FREECODE_CONFIG_DIR']!, 'config.json'),
      JSON.stringify({
        accessMode: 'byok',
        providers: {
          groq: {
            enabled: true,
            type: 'openai-compatible',
            models: ['llama-3.3-70b-versatile'],
            billing: 'free-tier',
            apiKeyEnv: 'GROQ_API_KEY',
          },
        },
      }),
      { mode: 0o600 },
    );

    // The bare id resolves to groq via the single config pin, and the routed
    // chain names the provider/model. A key is required; the check that informs
    // admissibility is presence-only and does not print a credential.
    const { code, stdout } = await runCli(['models', 'which', 'llama-3.3-70b-versatile'], {
      ...env,
      GROQ_API_KEY: 'gsk-fake', // presence-only; value never printed
    });
    expect(code).toBe(0);
    expect(stdout).toContain('groq');
    expect(stdout).toContain('llama-3.3-70b-versatile');
    expect(stdout).not.toContain('gsk-fake');

    // With `--provider` an unknown bare id narrows the pool to groq; when the
    // provider has no such model, the empty reason is truthful, not a guess.
    const { code: code2 } = await runCli(
      ['models', 'which', 'unknown-model', '--provider', 'groq'],
      { ...env, GROQ_API_KEY: 'gsk-fake' },
    );
    expect(code2).toBe(0);
  });
});

describe.skipIf(built)('cli end-to-end (skipped)', () => {
  it('is skipped because dist/index.js is absent — run `npm run build` first', () => {
    expect(built).toBe(false);
  });
});
