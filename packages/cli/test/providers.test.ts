/**
 * `providers` command tests.
 *
 * `add` must write the *raw* config file — the user's authored object — without
 * expanding it with every schema default, and without clobbering other keys.
 * `list` renders billing provenance, never a fabricated price.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runAdd, runCheck, runList } from '../src/commands/providers.js';

import {
  captureConsole,
  cleanupTempEnv,
  makeContext,
  withTempEnv,
  writeUserConfigValue,
} from './helpers/context.js';
import type { CliContext } from './helpers/context.js';

async function freshContext(): Promise<CliContext> {
  await withTempEnv();
  return makeContext();
}

afterAll(async () => {
  await cleanupTempEnv();
});

describe('providers list', () => {
  it('renders each built-in with billing provenance (no prices)', async () => {
    const ctx = await freshContext();
    const captured = captureConsole();
    try {
      await runList(ctx);
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    expect(text).toContain('anthropic');
    expect(text).toContain('ollama');
    expect(text).not.toMatch(/[$€£]\d/);
    expect(text).not.toMatch(/per-token|\bprice\b|\bcost\b/i);
  });
});

describe('providers add', () => {
  it('writes a minimal provider block without clobbering existing keys', async () => {
    await withTempEnv();
    await writeUserConfigValue({
      accessMode: 'byok',
      providers: { groq: { type: 'openai-compatible', enabled: true } },
    });
    const ctx = await makeContext();

    const captured = captureConsole();
    try {
      await runAdd(ctx, 'ollama');
    } finally {
      captured.restore();
    }
    expect(captured.stdout.join('\n')).toContain('Enabled ollama');

    const configDir = process.env['FREECODE_CONFIG_DIR'];
    const raw = JSON.parse(
      await fs.readFile(path.join(configDir!, 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    // The existing provider survives.
    expect(raw['accessMode']).toBe('byok');
    expect((raw['providers'] as Record<string, unknown>)['groq']).toBeDefined();
    // The new block is minimal and enabled.
    const ollama = (raw['providers'] as Record<string, unknown>)['ollama'] as Record<
      string,
      unknown
    >;
    expect(ollama['enabled']).toBe(true);
    // No schema-default expansion: no timeoutMs, no maxConcurrency, etc.
    expect(ollama['timeoutMs']).toBeUndefined();
    expect(ollama['maxConcurrency']).toBeUndefined();
  });

  it('errors for an unknown provider id', async () => {
    const ctx = await freshContext();
    await expect(runAdd(ctx, 'not-a-provider')).rejects.toThrow();
  });

  it('is a no-op when the provider is already enabled', async () => {
    await withTempEnv();
    await writeUserConfigValue({
      providers: { groq: { type: 'openai-compatible', enabled: true } },
    });
    const ctx = await makeContext();
    const captured = captureConsole();
    try {
      await runAdd(ctx, 'groq');
    } finally {
      captured.restore();
    }
    expect(captured.stdout.join('\n')).toContain('already enabled');
  });
});

describe('providers check', () => {
  it('resolves a configured provider without a network call', async () => {
    await withTempEnv();
    await writeUserConfigValue({
      providers: { groq: { type: 'openai-compatible', enabled: true } },
    });
    const ctx = await makeContext({});
    await ctx.store.set('groq', 'gsk-test');
    const captured = captureConsole();
    try {
      await runCheck(ctx, 'groq');
    } finally {
      captured.restore();
    }
    expect(captured.stdout.join('\n')).toContain('https://api.groq.com');
  });
});
