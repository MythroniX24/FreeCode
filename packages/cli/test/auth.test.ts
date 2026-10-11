/**
 * `auth` command security tests.
 *
 * The load-bearing properties:
 *
 *  - `login` accepts a value from a pipe and stores it; a value typed into
 *    argv is never supported (so nothing echoes in `ps`/history).
 *  - `status` reports only presence and backend, never a value.
 *  - `list` renders only the masked tail via `describeCredential`.
 *  - `logout` removes. There is no path back that prints a stored value.
 */

import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthError, UsageError } from '@freecode/core';

import { runList, runLogin, runLogout, runStatus } from '../src/commands/auth.js';

import { captureConsole, cleanupTempEnv, makeContext, withTempEnv } from './helpers/context.js';
import type { CliContext } from './helpers/context.js';

let ctx: CliContext;
let originalStdin: NodeJS.ReadStream;

beforeEach(async () => {
  await withTempEnv();
  ctx = await makeContext();
  originalStdin = process.stdin;
});

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
});

afterAll(async () => {
  await cleanupTempEnv();
});

/** Feed `text` through a non-TTY stdin so `runLogin` takes the pipe path. */
function pipeInput(text: string): void {
  const stream = Readable.from([text]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, 'isTTY', { value: false });
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
}

describe('auth login', () => {
  it('stores a key read from a pipe (nothing echoed, no argv)', async () => {
    pipeInput('sk-live-abcdef012\n');
    const captured = captureConsole();
    try {
      await runLogin(ctx, 'groq');
    } finally {
      captured.restore();
    }
    expect(await ctx.store.get('groq')).toBe('sk-live-abcdef012');
    // Nothing prints the value.
    expect(captured.stdout.join('\n')).not.toContain('sk-live-abcdef012');
  });

  it('rejects an empty key', async () => {
    pipeInput('\n');
    await expect(runLogin(ctx, 'groq')).rejects.toThrow(UsageError);
  });

  it('rejects a provider id that could escape the store namespace', async () => {
    await expect(runLogin(ctx, '../etc/passwd')).rejects.toThrow(AuthError);
  });
});

describe('auth status', () => {
  it('shows presence and backend, never a value', async () => {
    await ctx.store.set('groq', 'sk-abcdefgh');
    const captured = captureConsole();
    try {
      await runStatus(ctx);
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    expect(text).toContain('groq');
    expect(text).toContain('key present');
    expect(text).not.toContain('sk-abcdefgh');
  });
});

describe('auth list', () => {
  it('renders only the masked tail of a stored key', async () => {
    await ctx.store.set('groq', 'sk-live-abcdef012');
    const captured = captureConsole();
    try {
      await runList(ctx);
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    // The tail keeps only the first/last four chars.
    expect(text).not.toContain('sk-live-abcdef012');
    expect(text).toMatch(/sk-l…f012/);
  });

  it('reports an empty store', async () => {
    const captured = captureConsole();
    try {
      await runList(ctx);
    } finally {
      captured.restore();
    }
    expect(captured.stdout.join('\n')).toMatch(/No credentials stored/);
  });
});

describe('auth logout', () => {
  it('removes a stored credential', async () => {
    await ctx.store.set('groq', 'sk-abcdef');
    await runLogout(ctx, 'groq');
    expect(await ctx.store.get('groq')).toBeUndefined();
  });

  it('errors when nothing was stored', async () => {
    await expect(runLogout(ctx, 'groq')).rejects.toThrow(AuthError);
  });
});
