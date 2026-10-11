/**
 * `config` command security tests.
 *
 * The load-bearing property is that a credential-shaped value never reaches the
 * terminal in any mode. `show` redacts it, `get` renders a path through the
 * same redaction, and `set` refuses to write a value that would defeat the
 * schema (it validates the patched config before touching disk).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, UsageError } from '@freecode/core';

import { runGet, runSet, runShow } from '../src/commands/config.js';

import type { CliContext } from './helpers/context.js';
import {
  captureConsole,
  cleanupTempEnv,
  makeContext,
  withTempEnv,
  writeUserConfigValue,
} from './helpers/context.js';

let ctx: CliContext;

beforeEach(async () => {
  await withTempEnv();
  ctx = await makeContext();
});

afterAll(async () => {
  await cleanupTempEnv();
});

describe('config show', () => {
  it('never prints a secret-shaped provider header value', async () => {
    await writeUserConfigValue({
      providers: {
        custom: {
          type: 'openai-compatible',
          headers: { Authorization: 'Bearer sk-proj-abcdef012345' },
        },
      },
    });
    // Rebuild the context so the just-written file is the one that loads.
    ctx = await makeContext();

    const captured = captureConsole();
    try {
      await runShow(ctx);
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    expect(text).not.toContain('sk-proj-abcdef012345');
    expect(text).not.toMatch(/sk-proj-[a-z0-9]+/i);
  });

  it('renders valid JSON', async () => {
    const captured = captureConsole();
    try {
      await runShow(ctx);
    } finally {
      captured.restore();
    }
    const parsed = JSON.parse(captured.stdout.join('\n')) as Record<string, unknown>;
    expect(parsed['accessMode']).toBeDefined();
  });
});

describe('config get', () => {
  it('reads a dotted path', async () => {
    const captured = captureConsole();
    try {
      await runGet(ctx, 'accessMode');
    } finally {
      captured.restore();
    }
    // The default access mode is `auto`; the value round-trips as JSON.
    const parsed = JSON.parse(captured.stdout.join('\n')) as string;
    expect(parsed).toBe('auto');
  });

  it('throws UsageError for an unknown path', async () => {
    await expect(runGet(ctx, 'no.such.path')).rejects.toThrow(UsageError);
  });
});

describe('config set', () => {
  it('writes a valid dotted path and persists it', async () => {
    await runSet(ctx, 'accessMode', 'hosted');
    const configDir = process.env['FREECODE_CONFIG_DIR'];
    const raw = JSON.parse(
      await fs.readFile(path.join(configDir!, 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw['accessMode']).toBe('hosted');
  });

  it('rejects an invalid value without writing', async () => {
    await expect(runSet(ctx, 'accessMode', 'bogus')).rejects.toThrow(ConfigError);
    const configDir = process.env['FREECODE_CONFIG_DIR'];
    const file = path.join(configDir!, 'config.json');
    const exists = await fs.stat(file).catch(() => undefined);
    if (exists !== undefined) {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      expect(raw['accessMode']).not.toBe('bogus');
    }
  });

  it('rejects a path with traversal metacharacters', async () => {
    await expect(runSet(ctx, '../escape', 'x')).rejects.toThrow(UsageError);
  });
});
