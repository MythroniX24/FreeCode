/**
 * Configuration tests — schema defaults, the precedence chain, and the rule that
 * a project config cannot widen its own permissions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from '../src/errors.js';
import {
  deepMerge,
  environmentLayer,
  getAtPath,
  loadConfig,
  redactConfigForDisplay,
  setAtPath,
} from '../src/config/loader.js';
import { parseConfig, withDefaults } from '../src/config/schema.js';
import { cleanupTempDirs, makeTempDir } from './helpers/fs.js';

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await makeTempDir('config-');
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await cleanupTempDirs();
});

/** Write a JSON config file, creating parent directories. */
async function writeConfig(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

describe('defaults', () => {
  it('applies every default for an empty input', () => {
    const config = withDefaults({});
    expect(config.version).toBe(1);
    expect(config.accessMode).toBe('auto');
    expect(config.agent.maxIterations).toBe(24);
    expect(config.security.confineToWorkspace).toBe(true);
    expect(config.security.allowSensitiveReads).toBe(false);
    expect(config.quota.allowPaidModels).toBe(false);
    expect(config.routing.allowPaidFallback).toBe(false);
    expect(config.approval.mode).toBe('ask');
  });

  it('parses nested defaults through a prefault rather than returning a bare object', () => {
    // Regression guard: Zod 4's `.default({})` short-circuits parsing and would
    // leave `agent.maxIterations` undefined, silently disabling the iteration
    // cap. `.prefault({})` feeds the empty object through the schema instead.
    // `providers` and `meta` are legitimately empty records — the check is that
    // the *fixed-shape* sections are fully populated, and that a scalar inside
    // one of them is a real number rather than `undefined`.
    const config = withDefaults({});
    for (const name of [
      'agent',
      'security',
      'approval',
      'quota',
      'routing',
      'discovery',
      'gateway',
      'output',
      'logging',
    ] as const) {
      expect(Object.keys(config[name]).length, `${name} must be defaulted`).toBeGreaterThan(0);
    }
    expect(typeof config.agent.maxIterations).toBe('number');
    expect(Number.isFinite(config.agent.maxIterations)).toBe(true);
    // The exact failure mode being guarded against: an undefined cap means no cap.
    expect(config.security.confineToWorkspace).toBe(true);
  });

  it('rejects an iteration limit above the hard ceiling', () => {
    const result = parseConfig({ agent: { maxIterations: 10_000 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('agent.maxIterations');
  });

  it('rejects a negative timeout', () => {
    const result = parseConfig({ agent: { requestTimeoutMs: -1 } });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown access mode', () => {
    const result = parseConfig({ accessMode: 'unlimited' });
    expect(result.ok).toBe(false);
  });

  it('rejects a provider base URL that is not http(s)', () => {
    const result = parseConfig({ providers: { x: { baseUrl: 'ftp://example.com' } } });
    expect(result.ok).toBe(false);
  });

  it('reports the offending path in the issue list', () => {
    const result = parseConfig({ providers: { openai: { timeoutMs: 10 } } });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.some((i) => i.path === 'providers.openai.timeoutMs')).toBe(true);
  });
});

describe('path helpers', () => {
  it('sets a nested value, creating containers', () => {
    const target: Record<string, unknown> = {};
    setAtPath(target, 'a.b.c', 1);
    expect(target).toEqual({ a: { b: { c: 1 } } });
  });

  it('overwrites a scalar encountered mid-path with an object', () => {
    const target: Record<string, unknown> = { a: 5 };
    setAtPath(target, 'a.b', 1);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it('gets a nested value and returns undefined when absent', () => {
    expect(getAtPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(getAtPath({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(getAtPath(null, 'a')).toBeUndefined();
  });
});

describe('deepMerge', () => {
  it('merges nested objects', () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it('replaces arrays rather than concatenating', () => {
    // A user setting `trustedCommands: ["make"]` expects to set the list.
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it('ignores undefined overrides', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });
});

describe('environment layer', () => {
  it('maps FREECODE_* variables onto config paths', () => {
    const { values, names } = environmentLayer({
      FREECODE_DEFAULT_MODEL: 'groq/llama-3.3-70b',
      FREECODE_MAX_ITERATIONS: '40',
      FREECODE_LOG_LEVEL: 'debug',
    });
    expect(values).toMatchObject({
      defaultModel: 'groq/llama-3.3-70b',
      agent: { maxIterations: 40 },
      logging: { level: 'debug' },
    });
    expect(names).toContain('FREECODE_MAX_ITERATIONS');
  });

  it('coerces boolean-looking values', () => {
    const { values } = environmentLayer({ FREECODE_ALLOW_PAID_MODELS: 'true' });
    expect(getAtPath(values, 'quota.allowPaidModels')).toBe(true);
  });

  it('ignores empty values', () => {
    const { names } = environmentLayer({ FREECODE_DEFAULT_MODEL: '' });
    expect(names).not.toContain('FREECODE_DEFAULT_MODEL');
  });
});

describe('precedence', () => {
  it('lets the user config override defaults', async () => {
    const userConfig = path.join(home, 'config.json');
    await writeConfig(userConfig, { agent: { maxIterations: 5 } });
    const { config } = await loadConfig({
      cwd: project,
      userConfigPath: userConfig,
      env: {},
      ignoreProjectConfig: true,
    });
    expect(config.agent.maxIterations).toBe(5);
    expect(config.agent.maxToolCalls).toBe(200); // untouched default survives
  });

  it('lets the project config override the user config', async () => {
    const userConfig = path.join(home, 'config.json');
    await writeConfig(userConfig, { defaultModel: 'a/one' });
    await writeConfig(path.join(project, '.freecode', 'config.json'), { defaultModel: 'b/two' });

    const { config, projectConfigPath } = await loadConfig({
      cwd: project,
      userConfigPath: userConfig,
      env: {},
    });
    expect(config.defaultModel).toBe('b/two');
    expect(projectConfigPath).toContain('.freecode');
  });

  it('lets a local project override beat the shared project config', async () => {
    await writeConfig(path.join(project, '.freecode', 'config.json'), { defaultModel: 'shared/x' });
    await writeConfig(path.join(project, '.freecode', 'config.local.json'), {
      defaultModel: 'local/y',
    });
    const { config } = await loadConfig({
      cwd: project,
      env: {},
      userConfigPath: path.join(home, 'none.json'),
    });
    expect(config.defaultModel).toBe('local/y');
  });

  it('lets the environment override both config files', async () => {
    await writeConfig(path.join(home, 'config.json'), { defaultModel: 'file/model' });
    const { config } = await loadConfig({
      cwd: project,
      userConfigPath: path.join(home, 'config.json'),
      env: { FREECODE_DEFAULT_MODEL: 'env/model' },
      ignoreProjectConfig: true,
    });
    expect(config.defaultModel).toBe('env/model');
  });

  it('lets CLI overrides beat everything', async () => {
    await writeConfig(path.join(home, 'config.json'), { defaultModel: 'file/model' });
    const { config } = await loadConfig({
      cwd: project,
      userConfigPath: path.join(home, 'config.json'),
      env: { FREECODE_DEFAULT_MODEL: 'env/model' },
      cliOverrides: { defaultModel: 'cli/model' },
      ignoreProjectConfig: true,
    });
    expect(config.defaultModel).toBe('cli/model');
  });

  it('records the contributing layers in order', async () => {
    await writeConfig(path.join(home, 'config.json'), { defaultModel: 'file/model' });
    const { layers } = await loadConfig({
      cwd: project,
      userConfigPath: path.join(home, 'config.json'),
      env: { FREECODE_LOG_LEVEL: 'debug' },
      cliOverrides: { defaultProvider: 'groq' },
      ignoreProjectConfig: true,
    });
    expect(layers.map((l) => l.name)).toEqual(['defaults', 'user', 'environment', 'cli']);
  });
});

describe('project config restrictions', () => {
  it('refuses a project config that sets a security key', async () => {
    await writeConfig(path.join(project, '.freecode', 'config.json'), {
      security: { allowSensitiveReads: true },
    });
    await expect(
      loadConfig({ cwd: project, env: {}, userConfigPath: path.join(home, 'none.json') }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('refuses a project config that disables approval', async () => {
    await writeConfig(path.join(project, '.freecode', 'config.json'), {
      approval: { mode: 'yolo' },
    });
    await expect(
      loadConfig({ cwd: project, env: {}, userConfigPath: path.join(home, 'none.json') }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('names the offending keys in the error', async () => {
    await writeConfig(path.join(project, '.freecode', 'config.json'), {
      security: { allowSensitiveReads: true },
      logging: { level: 'trace' },
    });
    const error = await loadConfig({
      cwd: project,
      env: {},
      userConfigPath: path.join(home, 'none.json'),
    }).catch((e: unknown) => e as ConfigError);
    expect((error as ConfigError).message).toContain('security.allowSensitiveReads');
    expect((error as ConfigError).message).toContain('logging.level');
  });

  it('permits presentation settings in a project config', async () => {
    await writeConfig(path.join(project, '.freecode', 'config.json'), {
      output: { format: 'json' },
      routing: { preferFree: true },
      defaultModel: 'groq/llama-3.3-70b',
    });
    const { config } = await loadConfig({
      cwd: project,
      env: {},
      userConfigPath: path.join(home, 'none.json'),
    });
    expect(config.output.format).toBe('json');
    expect(config.defaultModel).toBe('groq/llama-3.3-70b');
  });

  it('allows a local override to set security keys, because the user authored it', async () => {
    await writeConfig(path.join(project, '.freecode', 'config.local.json'), {
      security: { allowSensitiveReads: true },
    });
    const { config } = await loadConfig({
      cwd: project,
      env: {},
      userConfigPath: path.join(home, 'none.json'),
    });
    expect(config.security.allowSensitiveReads).toBe(true);
  });

  it('can be told to ignore project configuration entirely', async () => {
    await writeConfig(path.join(project, '.freecode', 'config.json'), {
      security: { allowSensitiveReads: true },
    });
    const { config } = await loadConfig({
      cwd: project,
      env: {},
      userConfigPath: path.join(home, 'none.json'),
      ignoreProjectConfig: true,
    });
    expect(config.security.allowSensitiveReads).toBe(false);
  });
});

describe('workspace resolution', () => {
  it('defaults the workspace to the directory containing package.json', async () => {
    await writeFile(path.join(project, 'package.json'), '{}', 'utf8');
    const nested = path.join(project, 'src', 'deep');
    await mkdir(nested, { recursive: true });
    const { config } = await loadConfig({
      cwd: nested,
      env: {},
      userConfigPath: path.join(home, 'none.json'),
      ignoreProjectConfig: true,
    });
    expect(config.workspace).toBe(project);
  });

  it('honours an explicit workspace setting', async () => {
    const explicit = path.join(root, 'elsewhere');
    await mkdir(explicit, { recursive: true });
    const { config } = await loadConfig({
      cwd: project,
      env: { FREECODE_WORKSPACE: explicit },
      userConfigPath: path.join(home, 'none.json'),
      ignoreProjectConfig: true,
    });
    expect(config.workspace).toBe(explicit);
  });
});

describe('malformed configuration', () => {
  it('rejects invalid JSON with a helpful error', async () => {
    const userConfig = path.join(home, 'config.json');
    await writeFile(userConfig, '{ not json', 'utf8');
    await expect(
      loadConfig({ cwd: project, userConfigPath: userConfig, env: {}, ignoreProjectConfig: true }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects a JSON array as the root', async () => {
    const userConfig = path.join(home, 'config.json');
    await writeFile(userConfig, '[1,2,3]', 'utf8');
    await expect(
      loadConfig({ cwd: project, userConfigPath: userConfig, env: {}, ignoreProjectConfig: true }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('accepts an empty file as an empty object', async () => {
    const userConfig = path.join(home, 'config.json');
    await writeFile(userConfig, '   ', 'utf8');
    const { config } = await loadConfig({
      cwd: project,
      userConfigPath: userConfig,
      env: {},
      ignoreProjectConfig: true,
    });
    expect(config.agent.maxIterations).toBe(24);
  });
});

describe('redactConfigForDisplay', () => {
  it('masks provider header values', () => {
    const config = withDefaults({
      providers: { custom: { headers: { Authorization: 'Bearer real-secret-value' } } },
    });
    const shown = redactConfigForDisplay(config);
    const headers = (shown['providers'] as Record<string, { headers: Record<string, string> }>)[
      'custom'
    ]!.headers;
    expect(headers['Authorization']).toBe('[REDACTED]');
  });

  it('does not mutate the input config', () => {
    const config = withDefaults({ providers: { custom: { headers: { X: 'value' } } } });
    redactConfigForDisplay(config);
    expect(config.providers['custom']?.headers['X']).toBe('value');
  });
});
