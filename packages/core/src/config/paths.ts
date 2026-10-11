/**
 * Platform-aware location of FreeCode's configuration, data and cache files.
 *
 * Follows the XDG Base Directory spec on Unix and the known-folder conventions
 * on Windows, because writing into the user's home directory root is hostile on
 * every platform and outright broken on Termux (where `$HOME` is the app's
 * private data directory and is the *only* reliable writable location).
 *
 * Every path is overridable by an environment variable so that tests, CI and
 * containers can redirect state without touching the user's real configuration.
 */

import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'freecode';

/** Environment variables that relocate FreeCode's directories. */
export const PATH_ENV = {
  configDir: 'FREECODE_CONFIG_DIR',
  dataDir: 'FREECODE_DATA_DIR',
  cacheDir: 'FREECODE_CACHE_DIR',
} as const;

const WINDOWS = process.platform === 'win32';
const DARWIN = process.platform === 'darwin';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/** True when running under Termux on Android. */
export function isTermux(): boolean {
  if (process.platform !== 'linux') return false;
  if (env('TERMUX_VERSION') !== undefined) return true;
  if (env('PREFIX')?.includes('com.termux') === true) return true;
  return process.env['ANDROID_ROOT'] !== undefined && process.env['ANDROID_DATA'] !== undefined;
}

/** Base directory for user-specific configuration. */
export function configHome(): string {
  const override = env(PATH_ENV.configDir);
  if (override) return path.resolve(override);

  if (WINDOWS) {
    const appData = env('APPDATA') ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_NAME);
  }
  const xdg = env('XDG_CONFIG_HOME');
  if (xdg) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), '.config', APP_NAME);
}

/** Base directory for durable application data (checkpoints, registry cache). */
export function dataHome(): string {
  const override = env(PATH_ENV.dataDir);
  if (override) return path.resolve(override);

  if (WINDOWS) {
    const local = env('LOCALAPPDATA') ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, APP_NAME);
  }
  if (DARWIN) return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  const xdg = env('XDG_DATA_HOME');
  if (xdg) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), '.local', 'share', APP_NAME);
}

/** Base directory for regenerable cache data. */
export function cacheHome(): string {
  const override = env(PATH_ENV.cacheDir);
  if (override) return path.resolve(override);

  if (WINDOWS) {
    const local = env('LOCALAPPDATA') ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, APP_NAME, 'cache');
  }
  if (DARWIN) return path.join(os.homedir(), 'Library', 'Caches', APP_NAME);
  const xdg = env('XDG_CACHE_HOME');
  if (xdg) return path.join(xdg, APP_NAME);
  return path.join(os.homedir(), '.cache', APP_NAME);
}

/** `config.json` — validated user settings. Never contains secrets. */
export function userConfigPath(): string {
  return path.join(configHome(), 'config.json');
}

/**
 * Where BYOK API keys live when no OS keyring is available.
 *
 * **This file is a plaintext fallback.** It is created with mode 0600 and its
 * directory with 0700, and `doctor` reports whether a keyring is in use. The
 * trade-off is documented in `docs/security.md`: on Termux there is no
 * Secret Service / Keychain / DPAPI equivalent reachable from Node without a
 * native module, so the honest choice is a permission-restricted file plus a
 * loud warning rather than a native dependency that will not build on Android.
 */
export function credentialsPath(): string {
  if (isTermux()) return path.join(dataHome(), 'credentials.json');
  return path.join(configHome(), 'credentials.json');
}

/** Directory holding the model registry cache and discovery results. */
export function registryCacheDir(): string {
  return path.join(cacheHome(), 'registry');
}

/** Directory holding agent checkpoints (see `agent/checkpoint.ts`). */
export function checkpointsDir(): string {
  return path.join(dataHome(), 'checkpoints');
}

/** Directory holding session transcripts and agent state. */
export function sessionsDir(): string {
  return path.join(dataHome(), 'sessions');
}

/** Path to the usage/quota ledger for the local (non-hosted) access modes. */
export function usageLedgerPath(): string {
  return path.join(dataHome(), 'usage.json');
}

/**
 * Candidate project-config filenames, in precedence order within a directory.
 * `.freecode/config.json` wins over `freecode.config.json` because it lives in a
 * dedicated directory where the user can also keep local overrides.
 */
export const PROJECT_CONFIG_FILENAMES: readonly string[] = [
  path.join('.freecode', 'config.json'),
  'freecode.config.json',
];

/**
 * Local (git-ignored) project override filenames. Applied after the shared
 * project config so a developer can override a committed default without
 * modifying a tracked file.
 */
export const PROJECT_LOCAL_FILENAMES: readonly string[] = [
  path.join('.freecode', 'config.local.json'),
  'freecode.config.local.json',
];

/**
 * Walk from `startDir` up to the filesystem root, yielding each directory.
 * Used to find the project root when the user runs FreeCode from a subdirectory.
 */
export function* ancestors(startDir: string): Generator<string> {
  let current = path.resolve(startDir);
  for (;;) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/**
 * Locate the project root by walking upward looking for a marker.
 *
 * Markers are chosen to indicate *project* boundaries rather than VCS presence:
 * a nested git repository inside a monorepo should not silently redefine the
 * workspace, so `.git` alone is not sufficient — but it is the strongest signal
 * available for an arbitrary directory, so it is included last.
 */
export const PROJECT_ROOT_MARKERS: readonly string[] = [
  ...PROJECT_CONFIG_FILENAMES,
  'package.json',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'CMakeLists.txt',
  '.git',
];

/**
 * Find the nearest ancestor containing a project marker.
 * Returns `startDir` when nothing is found — the current directory is always a
 * valid workspace, even when it is not a recognisable project.
 */
export function findProjectRoot(
  startDir: string,
  markers: readonly string[] = PROJECT_ROOT_MARKERS,
): string {
  const resolvedStart = path.resolve(startDir);
  let fallback = resolvedStart;
  for (const dir of ancestors(resolvedStart)) {
    for (const marker of markers) {
      // `existsSync` is avoided here so the function stays usable from tests
      // that stub the filesystem; callers pass a real path in practice.
      if (markerExists(path.join(dir, marker))) {
        fallback = dir;
        return dir;
      }
    }
  }
  return fallback;
}

// `node:fs` is imported lazily to keep this module importable in environments
// that only need the path helpers (the gateway's config loader, for example).
import { existsSync } from 'node:fs';

function markerExists(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}
