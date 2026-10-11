/**
 * Configuration loading and the precedence chain.
 *
 * Precedence, lowest to highest (matching the documented order):
 *   1. Safe built-in defaults
 *   2. User configuration        (`$XDG_CONFIG_HOME/freecode/config.json`)
 *   3. Project configuration     (`.freecode/config.json`, permitted keys only)
 *   4. Environment variables     (`FREECODE_*`)
 *   5. Explicit command-line options
 *
 * Two rules keep this safe:
 *
 *   - **Project config is untrusted.** It may set presentation and routing
 *     preferences, but `security.*`, `approval.*`, `quota.*` and `logging.*` are
 *     refused outright (`PROJECT_FORBIDDEN_PREFIXES`). A repository must not be
 *     able to widen its own permissions. Local, git-ignored project overrides are
 *     exempt because they are authored by the person running the tool.
 *
 *   - **Secrets never live in config.** Only the *name* of an environment
 *     variable is stored (`providers.<id>.apiKeyEnv`). Values come from the
 *     credential store (see `auth/`). This makes `config show` trivially safe.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from '../errors.js';
import {
  PROJECT_CONFIG_FILENAMES,
  PROJECT_LOCAL_FILENAMES,
  ancestors,
  configHome,
  findProjectRoot,
  userConfigPath,
} from './paths.js';
import {
  PROJECT_FORBIDDEN_PREFIXES,
  parseConfig,
  type ConfigIssue,
  type FreecodeConfig,
} from './schema.js';

/** A single layer's contribution, retained for `config show --explain`. */
export interface ConfigLayer {
  readonly name: 'defaults' | 'user' | 'project' | 'project-local' | 'environment' | 'cli';
  readonly source: string;
  readonly values: Record<string, unknown>;
}

export interface LoadedConfig {
  readonly config: FreecodeConfig;
  /** Every layer that contributed, in application order. */
  readonly layers: readonly ConfigLayer[];
  /** Absolute path of the config file used, when one was found. */
  readonly userConfigPath: string | undefined;
  readonly projectConfigPath: string | undefined;
  /** Non-fatal problems (a malformed project config that was skipped, say). */
  readonly warnings: readonly string[];
}

export interface LoadOptions {
  /** Starting directory for project-root detection. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Skip project configuration entirely (`--no-project-config`). */
  readonly ignoreProjectConfig?: boolean;
  /** Explicit user config path (`--config <path>`). */
  readonly userConfigPath?: string;
  /** Values from parsed CLI flags, applied last. */
  readonly cliOverrides?: Record<string, unknown>;
  /** Environment to read. Injectable for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Whether to error when a config file is missing. */
  readonly requireUserConfig?: boolean;
}

/** Environment variables honoured by the loader, mapped to config paths. */
export const ENV_VAR_MAP: Readonly<Record<string, string>> = {
  FREECODE_ACCESS_MODE: 'accessMode',
  FREECODE_DEFAULT_MODEL: 'defaultModel',
  FREECODE_DEFAULT_PROVIDER: 'defaultProvider',
  FREECODE_WORKSPACE: 'workspace',
  FREECODE_GATEWAY_URL: 'gateway.url',
  FREECODE_GATEWAY_MODEL: 'gateway.model',
  FREECODE_LOG_LEVEL: 'logging.level',
  FREECODE_LOG_FORMAT: 'logging.format',
  FREECODE_OUTPUT_FORMAT: 'output.format',
  FREECODE_MAX_ITERATIONS: 'agent.maxIterations',
  FREECODE_REQUEST_TIMEOUT_MS: 'agent.requestTimeoutMs',
  FREECODE_COMMAND_TIMEOUT_MS: 'agent.commandTimeoutMs',
  FREECODE_APPROVAL_MODE: 'approval.mode',
  FREECODE_MAX_CONCURRENCY: 'quota.maxConcurrentRequests',
  FREECODE_ALLOW_PAID_MODELS: 'quota.allowPaidModels',
  FREECODE_DEBUG: 'logging.stackTraces',
};

/** Convert a dotted config path plus a raw string into a typed value. */
function coerce(pathKey: string, raw: string): unknown {
  const value = raw.trim();
  const booleanLike = /^(?:true|false|1|0|yes|no|on|off)$/i;
  if (booleanLike.test(value)) return /^(?:true|1|yes|on)$/i.test(value);
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  void pathKey;
  return value;
}

/** Assign `value` at a dotted path, creating intermediate objects. */
export function setAtPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const segments = dotted.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const existing = cursor[segment];
    if (
      existing === undefined ||
      existing === null ||
      typeof existing !== 'object' ||
      Array.isArray(existing)
    ) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = existing as Record<string, unknown>;
    }
  }
  cursor[segments.at(-1)!] = value;
}

/** Read a dotted path, returning undefined when any segment is absent. */
export function getAtPath(source: unknown, dotted: string): unknown {
  let cursor: unknown = source;
  for (const segment of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Deep-merge `override` into `base`, returning a new object.
 * Arrays and scalars replace; objects merge recursively. Arrays replace because
 * a user who sets `security.trustedCommands: ["make"]` expects to *set* that
 * list, not to append to a default.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = output[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      output[key] = deepMerge(existing, value);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verify that a project config file touches no forbidden key.
 *
 * Throws rather than warning: a silently-ignored security setting is worse than
 * a failed start, because the user believes it took effect.
 */
export function assertProjectConfigAllowed(values: unknown, source: string): void {
  const violations = collectForbiddenKeys(values, '');
  if (violations.length === 0) return;
  throw new ConfigError(
    `Project configuration ${source} sets keys that only the user may set: ${violations.join(', ')}.`,
    {
      details: { source, violations },
      hint: `Project files may not configure ${PROJECT_FORBIDDEN_PREFIXES.join(', ')}. Move these settings to your user config (${userConfigPath()}) or pass them on the command line.`,
    },
  );
}

/**
 * Collect the offending keys, reported as **leaf paths** rather than as the
 * forbidden section.
 *
 * `{ security: { allowSensitiveReads: true } }` is reported as
 * `security.allowSensitiveReads`, not as `security`. The section name alone
 * tells the user which area is wrong but not which line of their file to move,
 * which is the whole point of the error.
 */
function collectForbiddenKeys(value: unknown, prefix: string): string[] {
  if (!isPlainObject(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const dotted = prefix === '' ? key : `${prefix}.${key}`;
    const isForbidden = PROJECT_FORBIDDEN_PREFIXES.some(
      (forbidden) => dotted === forbidden.slice(0, -1) || dotted.startsWith(forbidden),
    );
    if (isForbidden) {
      const leaves = collectLeafPaths(child, dotted);
      found.push(...(leaves.length > 0 ? leaves : [dotted]));
      continue;
    }
    found.push(...collectForbiddenKeys(child, dotted));
  }
  return found;
}

/** Every leaf path under `value`, used to expand a forbidden section. */
function collectLeafPaths(value: unknown, prefix: string): string[] {
  if (!isPlainObject(value)) return [prefix];
  const leaves: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    leaves.push(...collectLeafPaths(child, `${prefix}.${key}`));
  }
  return leaves;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return undefined;
    throw new ConfigError(
      `Cannot read configuration file ${filePath}: ${(error as Error).message}`,
      {
        cause: error,
        details: { path: filePath },
      },
    );
  }

  if (contents.trim() === '') return {};

  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isPlainObject(parsed)) {
      throw new ConfigError(`Configuration file ${filePath} must contain a JSON object.`, {
        details: { path: filePath },
      });
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `Configuration file ${filePath} is not valid JSON: ${(error as Error).message}`,
      {
        cause: error,
        details: { path: filePath },
        hint: 'Run “freecode doctor” to see the exact parse location.',
      },
    );
  }
}

/** Locate the project root and the config file within it, if any. */
async function findProjectConfig(
  cwd: string,
): Promise<{ root: string; configPath?: string; localPath?: string }> {
  const root = findProjectRoot(cwd);

  for (const dir of ancestors(cwd)) {
    for (const name of PROJECT_CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      const values = await readJsonFile(candidate);
      if (values !== undefined) {
        const localPath = await findLocalConfig(dir);
        return {
          root: dir,
          configPath: candidate,
          ...(localPath === undefined ? {} : { localPath }),
        };
      }
    }
    // Stop walking once past the detected project root to avoid picking up an
    // unrelated config from a parent directory (e.g. `$HOME/.freecode`).
    if (dir === root) break;
  }

  const localPath = await findLocalConfig(root);
  return { root, ...(localPath === undefined ? {} : { localPath }) };
}

async function findLocalConfig(dir: string): Promise<string | undefined> {
  for (const name of PROJECT_LOCAL_FILENAMES) {
    const candidate = path.join(dir, name);
    const values = await readJsonFile(candidate);
    if (values !== undefined) return candidate;
  }
  return undefined;
}

/** Build the environment layer from `FREECODE_*` variables. */
export function environmentLayer(env: NodeJS.ProcessEnv): {
  values: Record<string, unknown>;
  names: string[];
} {
  const values: Record<string, unknown> = {};
  const names: string[] = [];
  for (const [envName, configPath] of Object.entries(ENV_VAR_MAP)) {
    const raw = env[envName];
    if (raw === undefined || raw === '') continue;
    setAtPath(values, configPath, coerce(configPath, raw));
    names.push(envName);
  }
  if (env['FREECODE_DEBUG'] === '1') setAtPath(values, 'logging.level', 'debug');
  return { values, names };
}

/**
 * Load and merge every configuration layer.
 *
 * Validation runs **once**, after all layers are merged, so an invalid value can
 * be reported with the path that produced it. A per-layer validation would fail
 * on the incomplete defaults of an intermediate layer.
 */
export async function loadConfig(options: LoadOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const layers: ConfigLayer[] = [];

  // ── Layer 1: defaults (implicit — captured for `--explain`) ───────────────
  layers.push({ name: 'defaults', source: 'built-in', values: {} });

  // ── Layer 2: user configuration ───────────────────────────────────────────
  const userPath = options.userConfigPath ?? userConfigPath();
  const userValues = await readJsonFile(userPath);
  if (userValues === undefined) {
    if (options.requireUserConfig) {
      throw new ConfigError(`No user configuration found at ${userPath}.`, {
        details: { path: userPath },
        hint: 'Run “freecode init” to create one.',
      });
    }
  } else {
    layers.push({ name: 'user', source: userPath, values: userValues });
  }

  // ── Layer 3: project configuration (restricted keys) ──────────────────────
  let projectConfigPath: string | undefined;
  let merged: Record<string, unknown> = userValues ?? {};

  if (options.ignoreProjectConfig !== true) {
    const project = await findProjectConfig(cwd);

    if (project.configPath !== undefined) {
      const projectValues = (await readJsonFile(project.configPath)) ?? {};
      assertProjectConfigAllowed(projectValues, project.configPath);
      layers.push({ name: 'project', source: project.configPath, values: projectValues });
      merged = deepMerge(merged, projectValues);
      projectConfigPath = project.configPath;
    }

    if (project.localPath !== undefined) {
      // Local overrides are authored by this user and are exempt from the
      // forbidden-prefix rule — but they are still validated by the schema.
      const localValues = (await readJsonFile(project.localPath)) ?? {};
      layers.push({ name: 'project-local', source: project.localPath, values: localValues });
      merged = deepMerge(merged, localValues);
      projectConfigPath ??= project.localPath;
    }
  }

  // ── Layer 4: environment variables ────────────────────────────────────────
  const envLayer = environmentLayer(env);
  if (envLayer.names.length > 0) {
    layers.push({
      name: 'environment',
      source: envLayer.names.join(', '),
      values: envLayer.values,
    });
    merged = deepMerge(merged, envLayer.values);
  }

  // ── Layer 5: command-line overrides ───────────────────────────────────────
  if (options.cliOverrides && Object.keys(options.cliOverrides).length > 0) {
    layers.push({ name: 'cli', source: 'command line', values: options.cliOverrides });
    merged = deepMerge(merged, options.cliOverrides);
  }

  // ── Validation ────────────────────────────────────────────────────────────
  // Strip `undefined` values that deep merging may have introduced.
  const parsed = parseConfig(stripUndefined(merged));
  if (!parsed.ok) {
    throw new ConfigError(formatIssues(parsed.issues), {
      details: { issues: parsed.issues },
      hint: 'Fix the listed keys, or run “freecode config show” to inspect the merged result.',
    });
  }

  const config = parsed.config;

  // Resolve the workspace: CLI/env/config, else the detected project root, else cwd.
  if (config.workspace === '') {
    const root = findProjectRoot(cwd);
    setAtPath(config as unknown as Record<string, unknown>, 'workspace', root);
  }

  // `--debug` in the CLI layer implies debug logging even if the config file
  // sets a quieter level, because the flag is the more specific intent.
  return {
    config,
    layers,
    userConfigPath: userValues === undefined ? undefined : userPath,
    projectConfigPath,
    warnings,
  };
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    out[key] = stripUndefined(child);
  }
  return out;
}

/** Render validation issues as a readable, path-first list. */
export function formatIssues(issues: readonly ConfigIssue[]): string {
  const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`);
  return ['Configuration is invalid:', ...lines].join('\n');
}

/**
 * Produce a redacted, display-ready view of the effective configuration.
 *
 * Because secrets are never stored in config, redaction is defence-in-depth: it
 * catches values a user pasted into `meta` or a provider header by mistake.
 */
export function redactConfigForDisplay(config: FreecodeConfig): Record<string, unknown> {
  const clone = structuredClone(config) as unknown as Record<string, unknown>;

  // Provider headers can legitimately carry a token; mask every value.
  const providers = clone['providers'];
  if (isPlainObject(providers)) {
    for (const entry of Object.values(providers)) {
      if (isPlainObject(entry) && isPlainObject(entry['headers'])) {
        for (const key of Object.keys(entry['headers'] as Record<string, unknown>)) {
          (entry['headers'] as Record<string, unknown>)[key] = '[REDACTED]';
        }
      }
    }
  }
  return clone;
}

/** Absolute path used by `config show` to report where settings came from. */
export function describeConfigLocations(cwd = process.cwd()): Record<string, string | undefined> {
  const projectRoot = findProjectRoot(cwd);
  return {
    configDir: configHome(),
    userConfig: userConfigPath(),
    projectRoot,
    projectConfig: PROJECT_CONFIG_FILENAMES.map((name) => path.join(projectRoot, name)).join(
      ' or ',
    ),
  };
}
