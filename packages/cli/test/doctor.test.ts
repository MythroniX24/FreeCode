/**
 * `doctor` command tests.
 *
 * `doctor` reports *presence* of a credential and its source provenance
 * (`store` / `env (NAME)`), never the value itself. This is the read-only health
 * check a user runs first, so it must be reliable and must not leak.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../src/commands/doctor.js';

import {
  captureConsole,
  cleanupTempEnv,
  makeContext,
  withTempEnv,
  writeUserConfigValue,
} from './helpers/context.js';
import type { CliContext } from './helpers/context.js';

let ctx: CliContext;

beforeEach(async () => {
  await withTempEnv();
  ctx = await makeContext();
});

afterAll(async () => {
  await cleanupTempEnv();
});

describe('doctor', () => {
  it('reports key presence without ever printing its value', async () => {
    // Configure groq so the doctor looks for its key.
    await writeUserConfigValue({
      providers: { groq: { type: 'openai-compatible', enabled: true } },
    });
    ctx = await makeContext();
    await ctx.store.set('groq', 'gsk-super-secret-ab');

    const captured = captureConsole();
    try {
      await runDoctor({ verbose: true, ctx });
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    expect(text).toContain('groq');
    expect(text).toContain('key=present');
    expect(text).not.toContain('gsk-super-secret-ab');
  });

  it('reports a missing key as actionable', async () => {
    // Configure groq but store no key: the doctor must flag it.
    await writeUserConfigValue({
      providers: { groq: { type: 'openai-compatible', enabled: true } },
    });
    ctx = await makeContext();

    const captured = captureConsole();
    try {
      await runDoctor({ verbose: false, ctx });
    } finally {
      captured.restore();
    }
    const text = captured.stdout.join('\n');
    expect(text).toContain('groq');
    expect(text).toMatch(/key missing/);
  });

  it('never prints an env var search name as a value', async () => {
    // A provider with a key resolved from its conventional env var is reported
    // as "env (NAME)" without ever printing the value.
    process.env['GROQ_API_KEY'] = 'gsk-env-secret';
    await writeUserConfigValue({
      providers: { groq: { type: 'openai-compatible', enabled: true } },
    });
    ctx = await makeContext();

    const captured = captureConsole();
    try {
      await runDoctor({ verbose: true, ctx });
    } finally {
      captured.restore();
    }
    delete process.env['GROQ_API_KEY'];
    const text = captured.stdout.join('\n');
    expect(text).toContain('env (GROQ_API_KEY)');
    expect(text).not.toContain('gsk-env-secret');
  });
});
