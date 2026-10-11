/**
 * Test fixtures for CLI commands.
 *
 * Every command takes a `CliContext`, so tests never touch the real user
 * config or credential file. A temp home (`FREECODE_CONFIG_DIR`,
 * `FREECODE_DATA_DIR`, `FREECODE_CACHE_DIR`) redirects every path helper; a stub
 * `CredentialStore` keeps credentials out of the filesystem entirely; and a
 * captured console lets a test assert what was printed (and, crucially, that a
 * secret-shaped value never appears).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, nullLogger } from '@freecode/core';
import type { CredentialStore } from '@freecode/core';

import type { CliContext } from '../../src/context.js';

export type { CliContext };

const createdDirs: string[] = [];

/**
 * Point the FreeCode path helpers at a temp directory.
 * Returns the dirs so a test can write config into them directly.
 */
export async function withTempEnv(): Promise<{
  configDir: string;
  dataDir: string;
  cacheDir: string;
}> {
  const base = path.join(os.homedir(), '.freecode-cli-test');
  await fs.mkdir(base, { recursive: true });
  const configDir = await fs.mkdtemp(path.join(base, 'config-'));
  const dataDir = await fs.mkdtemp(path.join(base, 'data-'));
  const cacheDir = await fs.mkdtemp(path.join(base, 'cache-'));
  process.env['FREECODE_CONFIG_DIR'] = configDir;
  process.env['FREECODE_DATA_DIR'] = dataDir;
  process.env['FREECODE_CACHE_DIR'] = cacheDir;
  createdDirs.push(configDir, dataDir, cacheDir);
  return { configDir, dataDir, cacheDir };
}

/** A credential store backed by an in-memory map. */
export function memoryStore(initial: Record<string, string> = {}): CredentialStore {
  const values = new Map(Object.entries(initial));
  return {
    backend: 'file',
    secure: false,
    describe: () => 'memory (test)',
    async get(providerId) {
      return values.get(providerId);
    },
    async set(providerId, value) {
      values.set(providerId, value);
    },
    async delete(providerId) {
      return values.delete(providerId);
    },
    async list() {
      return [...values.keys()].sort();
    },
  };
}

/**
 * Build a `CliContext` from the *current* redirected env dirs.
 *
 * A test calls `withTempEnv()` once, optionally writes a config file into the
 * redirected dir, then calls `makeContext()` to load it. `makeContext` never
 * resets the environment, so the file the test wrote is the one that loads.
 */
export async function makeContext(
  options: { configInput?: Record<string, unknown> } = {},
): Promise<CliContext> {
  const loaded = await loadConfig({
    cwd: process.cwd(),
    ignoreProjectConfig: true,
    ...(options.configInput === undefined ? {} : { cliOverrides: options.configInput }),
  });
  const store = memoryStore();
  return { config: loaded, store, logger: nullLogger(), cwd: process.cwd() };
}

export interface Captured {
  stdout: string[];
  stderr: string[];
  restore(): void;
}

/** Replace `console.log`/`console.error` with capture buffers. */
export function captureConsole(): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
  return {
    stdout,
    stderr,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

/** Write a user config file into the redirected config dir. */
export async function writeUserConfigValue(value: unknown): Promise<void> {
  const configDir = process.env['FREECODE_CONFIG_DIR'];
  if (configDir === undefined) throw new Error('withTempEnv must run first');
  const file = path.join(configDir, 'config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/** Remove the temp dirs created by this test file. Exposed for afterAll. */
export async function cleanupTempEnv(): Promise<void> {
  await Promise.all(
    createdDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
  for (const key of ['FREECODE_CONFIG_DIR', 'FREECODE_DATA_DIR', 'FREECODE_CACHE_DIR']) {
    delete process.env[key];
  }
}
