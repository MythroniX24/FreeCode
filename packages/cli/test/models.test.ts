/**
 * `models` command tests.
 *
 * The honesty property: a provider that cannot be reached is reported as a
 * failure (and sets a non-zero exit code); it is never dropped silently or
 * padded with invented model ids. A config-pinned model still lists even when
 * the provider is offline.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeRegistryCache } from '@freecode/core';

import { runList, runRefresh } from '../src/commands/models.js';

import {
  captureConsole,
  cleanupTempEnv,
  makeContext,
  withTempEnv,
  writeUserConfigValue,
} from './helpers/context.js';
import type { CliContext } from './helpers/context.js';

let ctx: CliContext;
let savedExitCode: typeof process.exitCode;

beforeEach(async () => {
  await withTempEnv();
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = savedExitCode;
});

afterAll(async () => {
  await cleanupTempEnv();
});

describe('models list', () => {
  it('lists cached models without a network call', async () => {
    const cacheDir = process.env['FREECODE_CACHE_DIR']!;
    await writeRegistryCache('groq', ['llama-3.3-70b-versatile', 'mixtral-8x7b'], {
      dir: `${cacheDir}/registry`,
    });
    ctx = await makeContext();

    const captured = captureConsole();
    try {
      await runList(ctx);
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    expect(text).toContain('groq/llama-3.3-70b-versatile');
    expect(text).toContain('groq/mixtral-8x7b');
  });

  it('lists config-pinned models even with no cache', async () => {
    await withTempEnv();
    await writeUserConfigValue({
      providers: { ollama: { type: 'ollama', enabled: true, models: ['llama3.2'] } },
    });
    ctx = await makeContext();

    const captured = captureConsole();
    try {
      await runList(ctx);
    } finally {
      captured.restore();
    }
    expect(captured.stdout.join('\n')).toContain('ollama/llama3.2');
  });

  it('filters by provider and search substring', async () => {
    const cacheDir = process.env['FREECODE_CACHE_DIR']!;
    await writeRegistryCache('groq', ['llama-3.3-70b-versatile'], { dir: `${cacheDir}/registry` });
    await writeRegistryCache('ollama', ['llama3.2'], { dir: `${cacheDir}/registry` });
    ctx = await makeContext();

    const captured = captureConsole();
    try {
      await runList(ctx, { provider: 'ollama' });
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    expect(text).toContain('ollama/llama3.2');
    expect(text).not.toContain('groq/');
  });

  it('reports an empty registry without inventing models', async () => {
    ctx = await makeContext();
    const captured = captureConsole();
    try {
      await runList(ctx);
    } finally {
      captured.restore();
    }
    expect(captured.stdout.join('\n')).toMatch(/No models found/);
  });
});

describe('models refresh', () => {
  it('reports unreachable providers honestly and sets a non-zero exit code', async () => {
    await withTempEnv();
    // Groq is enabled but has no key and no network: discovery must fail
    // honestly rather than fabricate a model list.
    await writeUserConfigValue({
      providers: {
        groq: { type: 'openai-compatible', enabled: true, baseUrl: 'http://127.0.0.1:1' },
      },
    });
    ctx = await makeContext();

    const captured = captureConsole();
    try {
      await runRefresh(ctx);
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    expect(text).toMatch(/✗ groq:/);
    expect(process.exitCode).toBe(1);
  });

  it('reports a successful provider with a ✓ and does not set an exit code', async () => {
    await writeUserConfigValue({
      providers: { groq: { type: 'openai-compatible', enabled: true } },
    });
    ctx = await makeContext();
    await ctx.store.set('groq', 'gsk-test');

    const cacheDir = process.env['FREECODE_CACHE_DIR']!;
    // Pre-seed a *fresh* cache so discovery short-circuits the live fetch,
    // keeping the test offline while still exercising the success path.
    await writeRegistryCache('groq', ['llama-3.3-70b-versatile'], { dir: `${cacheDir}/registry` });
    await ctx.store.set('groq', 'gsk-test');

    const captured = captureConsole();
    try {
      await runRefresh(ctx);
    } finally {
      captured.restore();
    }
    expect(captured.stdout.join('\n')).toMatch(/✓ groq: 1 model/);
    expect(process.exitCode).toBeUndefined();
  });
});
