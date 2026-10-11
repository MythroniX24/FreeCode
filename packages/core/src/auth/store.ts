/**
 * Credential storage.
 *
 * BYOK keys are held in one of two backends, chosen at runtime:
 *
 *  - **OS keyring**, reached through the platform's own CLI (`secret-tool` on
 *    Linux, `security` on macOS). No native module is involved, so there is no
 *    build step and nothing to break on an unusual architecture.
 *  - **A permission-restricted file**, mode 0600 with a 0700 directory.
 *
 * The file backend is a genuine trade-off, and it is described as one rather
 * than dressed up: on Termux there is no Secret Service, Keychain or DPAPI
 * reachable from Node without a native module, and a native module that does not
 * build on Android is worse than an honest plaintext file with tight
 * permissions. `freecode auth status` says which backend is in use so the user
 * can make their own decision; `docs/security.md` records the reasoning.
 *
 * Invariants held here, and asserted by tests:
 *
 *  - **A key value is never logged, echoed, or included in an error.** The
 *    store returns values only from `get()`, and the CLI renders `list()` output
 *    through `maskTail()`.
 *  - **No credential is ever written to a config file.** Configuration holds the
 *    *name* of an environment variable at most (`providers.<id>.apiKeyEnv`).
 *  - **Writes are atomic.** A crash mid-write must not leave a truncated file
 *    that makes every previously-stored key unreadable.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { AuthError } from '../errors.js';
import { credentialsPath } from '../config/paths.js';
import { maskTail, redact } from '../util/redact.js';
import type { Logger } from '../util/logger.js';

const execFileAsync = promisify(execFile);

/** The credential store contract. */
export interface CredentialStore {
  /** Backend identifier, for `auth status`. */
  readonly backend: 'keyring' | 'file';
  /** Whether the backend can be trusted to keep the value confidential. */
  readonly secure: boolean;
  /** A human-readable description of where the value lives. */
  describe(): string;
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, value: string): Promise<void>;
  delete(providerId: string): Promise<boolean>;
  /** Provider ids with a stored credential. Never the values. */
  list(): Promise<string[]>;
}

const SERVICE_NAME = 'freecode';
const KEY_PREFIX = 'provider:';

/** Reject a provider id that could escape the store's namespace. */
export function assertValidProviderId(providerId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(providerId)) {
    throw new AuthError(`Invalid provider id “${providerId}”.`, {
      details: { providerId },
      hint: 'Provider ids are lowercase alphanumeric with dots, dashes or underscores.',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File backend
// ─────────────────────────────────────────────────────────────────────────────

/** A `{ "provider:id": "value" }` map on disk, mode 0600. */
export class FileCredentialStore implements CredentialStore {
  readonly backend = 'file' as const;
  readonly secure = false;
  readonly #file: string;

  constructor(file: string = credentialsPath()) {
    this.#file = file;
  }

  describe(): string {
    return `${this.#file} (mode 0600, plaintext — no OS keyring is available here)`;
  }

  async get(providerId: string): Promise<string | undefined> {
    assertValidProviderId(providerId);
    const entries = await this.#read();
    return entries[KEY_PREFIX + providerId];
  }

  async set(providerId: string, value: string): Promise<void> {
    assertValidProviderId(providerId);
    if (value === '') {
      throw new AuthError('Refusing to store an empty credential.', {
        hint: 'Run “freecode auth logout <provider>” to remove a credential instead.',
      });
    }

    const entries = await this.#read();
    entries[KEY_PREFIX + providerId] = value;
    await this.#write(entries);
  }

  async delete(providerId: string): Promise<boolean> {
    assertValidProviderId(providerId);
    const entries = await this.#read();
    const key = KEY_PREFIX + providerId;
    if (!(key in entries)) return false;
    delete entries[key];
    await this.#write(entries);
    return true;
  }

  async list(): Promise<string[]> {
    const entries = await this.#read();
    return Object.keys(entries)
      .filter((key) => key.startsWith(KEY_PREFIX))
      .map((key) => key.slice(KEY_PREFIX.length))
      .sort();
  }

  async #read(): Promise<Record<string, string>> {
    let contents: string;
    try {
      contents = await readFile(this.#file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return {};
      throw new AuthError(`Cannot read the credential file: ${(error as Error).message}`, {
        cause: error,
        details: { path: this.#file },
      });
    }

    if (contents.trim() === '') return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (cause) {
      // Deliberately not including the file contents in the message: a corrupt
      // credential file may contain a key, and this error is printed.
      throw new AuthError('The credential file is not valid JSON.', {
        cause,
        details: { path: this.#file },
        hint: `Inspect ${this.#file}, or delete it and run “freecode auth login” again.`,
      });
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AuthError('The credential file must contain a JSON object.', {
        details: { path: this.#file },
      });
    }

    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') entries[key] = value;
    }
    return entries;
  }

  /**
   * Write the store atomically.
   *
   * Write-then-rename, because a crash partway through an in-place write would
   * leave a truncated JSON file and silently destroy every credential in it.
   * The temporary file is created with 0600 from the start rather than being
   * chmodded afterwards, so there is no window where it is world-readable.
   */
  async #write(entries: Record<string, string>): Promise<void> {
    const directory = path.dirname(this.#file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // `mkdir` does not tighten an existing directory, so do it explicitly.
    await chmod(directory, 0o700).catch(() => undefined);

    const temporary = `${this.#file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, this.#file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new AuthError(`Cannot write the credential file: ${(error as Error).message}`, {
        cause: error,
        details: { path: this.#file },
      });
    }
    // Re-assert the mode: an existing file keeps its old permissions across a
    // rename in some filesystems, and the default umask may have widened them.
    await chmod(this.#file, 0o600).catch(() => undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyring backend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the argument vector for one keyring operation.
 *
 * Every argument is passed positionally through `execFile`, never through a
 * shell, so a provider id or a key containing shell metacharacters cannot be
 * interpreted. Returning arrays rather than command strings is the mechanism
 * that makes that structural rather than a matter of careful quoting.
 */
interface KeyringCommand {
  readonly binary: string;
  read(providerId: string): string[];
  write(providerId: string, value: string): string[];
  remove(providerId: string): string[];
  list(): string[];
}

/**
 * The platform command used to reach the keyring.
 *
 * Returning `undefined` means there is no keyring here and the file backend
 * should be used. `secret-tool` is probed for existence rather than assumed: a
 * headless Linux box frequently has neither the binary nor a running daemon.
 */
function keyringCommand(platform: NodeJS.Platform): KeyringCommand | undefined {
  if (platform === 'darwin') {
    return {
      binary: 'security',
      read: (id) => ['find-generic-password', '-s', SERVICE_NAME, '-a', id, '-w'],
      write: (id, value) => [
        'add-generic-password',
        '-U',
        '-s',
        SERVICE_NAME,
        '-a',
        id,
        '-w',
        value,
      ],
      remove: (id) => ['delete-generic-password', '-s', SERVICE_NAME, '-a', id],
      list: () => ['dump-keyring', '-d'],
    };
  }

  if (platform === 'linux') {
    return {
      binary: 'secret-tool',
      read: (id) => ['lookup', 'service', SERVICE_NAME, 'account', id],
      // The value is the last argument and is read positionally by secret-tool.
      write: (id, value) => [
        'store',
        '--label',
        `${SERVICE_NAME} credential for ${id}`,
        'service',
        SERVICE_NAME,
        'account',
        id,
        value,
      ],
      remove: (id) => ['clear', 'service', SERVICE_NAME, 'account', id],
      list: () => ['search', '--unlock', 'service', SERVICE_NAME],
    };
  }

  // Windows would need DPAPI, which is not reachable without a native module.
  return undefined;
}

/** Extract the account name from a keyring listing line, when decodable. */
function attributeValue(output: string, attribute: string): string | undefined {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(`${attribute.toLowerCase()}:`)) {
      return trimmed.slice(attribute.length + 1).trim();
    }
  }
  return undefined;
}

export class KeyringCredentialStore implements CredentialStore {
  readonly backend = 'keyring' as const;
  readonly secure = true;
  readonly #command: KeyringCommand;
  readonly #platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform, command?: KeyringCommand) {
    this.#platform = platform;
    const resolved = command ?? keyringCommand(platform);
    if (resolved === undefined) {
      throw new AuthError(`No keyring backend is available on ${platform}.`);
    }
    this.#command = resolved;
  }

  describe(): string {
    return `${this.#platform === 'darwin' ? 'macOS Keychain' : 'Secret Service'} (service “${SERVICE_NAME}”)`;
  }

  async get(providerId: string): Promise<string | undefined> {
    assertValidProviderId(providerId);
    try {
      const { stdout } = await execFileAsync(this.#command.binary, this.#command.read(providerId), {
        encoding: 'utf8',
      });
      const value = stdout.trim();
      return value === '' ? undefined : value;
    } catch (error) {
      // A missing entry is the documented "not found" exit status, not a failure.
      if (isNotFound(error)) return undefined;
      throw new AuthError(`Cannot read from the keyring: ${describeFailure(error)}`, {
        cause: error,
        hint: 'The keyring may be locked or the daemon may not be running.',
      });
    }
  }

  async set(providerId: string, value: string): Promise<void> {
    assertValidProviderId(providerId);
    if (value === '') {
      throw new AuthError('Refusing to store an empty credential.', {
        hint: `Run “freecode auth logout ${providerId}” to remove one instead.`,
      });
    }

    // The value is passed as an argument vector, never through a shell, so it
    // cannot be word-split, glob-expanded or interpreted as a command.
    try {
      await execFileAsync(this.#command.binary, this.#command.write(providerId, value), {
        encoding: 'utf8',
        // A failure message from the CLI must not be allowed to echo the value
        // into a captured buffer that a caller might then print.
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      // `error.message` is never used here — see `describeFailure`. It is the
      // one field that reproduces the argument vector, and therefore the key.
      throw new AuthError(`Cannot write to the keyring: ${describeFailure(error)}`, {
        cause: error,
        hint: 'Use “freecode auth login --store file” to keep the credential in a protected file instead.',
      });
    }
  }

  async delete(providerId: string): Promise<boolean> {
    assertValidProviderId(providerId);
    try {
      await execFileAsync(this.#command.binary, this.#command.remove(providerId), {
        encoding: 'utf8',
      });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new AuthError(`Cannot remove the keyring entry: ${describeFailure(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Provider ids present in the keyring.
   *
   * The keyring's own listing is parsed for the `account` attribute. This is
   * best-effort: when the format is unrecognised the result is an empty list
   * rather than a guess, because reporting a provider as configured when it is
   * not would send the user chasing a phantom.
   */
  async list(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(this.#command.binary, this.#command.list(), {
        encoding: 'utf8',
      });
      const found: string[] = [];
      for (const block of stdout.split(/\n(?=\S+:)/)) {
        const account = attributeValue(block, 'account');
        if (account !== undefined && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(account))
          found.push(account);
      }
      return [...new Set(found)].sort();
    } catch {
      return [];
    }
  }
}

function isNotFound(error: unknown): boolean {
  const status = (error as { code?: unknown }).code;
  // `security` exits 44 for "item not found"; `secret-tool` exits 1.
  return status === 44 || status === 1 || status === '44' || status === '1';
}

/**
 * Describe a failed keyring invocation without reproducing the credential.
 *
 * This is subtler than it looks, and the obvious implementation is wrong. A
 * `store` invocation carries the key *in its argument vector*, and Node's
 * `execFile` error message embeds the full command line — so
 * `error.message` is `Command failed: secret-tool store … <the key>`. Running
 * that through `redact()` is not sufficient either: the redactor recognises
 * known credential *shapes* (`sk-…` and friends), and a provider is free to
 * issue a key in any format it likes, so an unrecognised key would pass through
 * intact into the terminal and into any log that captured it.
 *
 * The rule here is therefore structural rather than pattern-based: `error.message`
 * is **discarded**, because it is the one field that is known to contain the
 * arguments. What is kept is the child's own stderr (a diagnostic the CLI wrote
 * about itself, which never contains the argument vector in any implementation
 * seen here) and, for a spawn failure, the message — a failed spawn never ran
 * the binary, so its message cannot contain the value.
 */
function describeFailure(error: unknown): string {
  const failure = error as { code?: unknown; status?: unknown; stderr?: unknown };

  const stderr = typeof failure.stderr === 'string' ? firstLine(failure.stderr) : '';
  if (stderr !== '') return redact(stderr);

  if (failure.code === 'ENOENT') {
    // Truncated for consistency with the HTTP layer: an interpolated path could
    // in principle be long, and there is nothing more to learn past a line.
    return redact(firstLine(error instanceof Error ? error.message : String(error)));
  }

  const status = failure.code ?? failure.status;
  return status === undefined
    ? 'the keyring command failed'
    : `the keyring command failed with status ${String(status)}`;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export interface CredentialStoreOptions {
  /** Force a backend. `auto` prefers the keyring and falls back to a file. */
  readonly backend?: 'auto' | 'keyring' | 'file';
  /** Override the file path. Used by tests. */
  readonly file?: string;
  readonly log?: Logger;
  /** Override platform detection. Used by tests. */
  readonly platform?: NodeJS.Platform;
  /** Override the keyring probe. Used by tests. */
  readonly probeKeyring?: () => Promise<boolean>;
}

/**
 * Choose a credential store.
 *
 * The keyring is preferred and its availability is *probed* rather than inferred
 * from the platform: `secret-tool` being absent on a headless Linux host is the
 * common case, and discovering that at first use (rather than at login) is the
 * difference between a clear error and a confusing one.
 */
export async function createCredentialStore(
  options: CredentialStoreOptions = {},
): Promise<CredentialStore> {
  const backend = options.backend ?? 'auto';
  const platform = options.platform ?? process.platform;

  if (backend === 'file') {
    return new FileCredentialStore(options.file);
  }

  if (platform !== 'linux' && platform !== 'darwin') {
    if (backend === 'keyring') {
      throw new AuthError(
        platform === 'win32'
          ? 'Windows credential storage needs a native module, which this build does not ship.'
          : `No keyring backend is available on ${platform}.`,
        { hint: 'Use “freecode auth login --store file”.' },
      );
    }
    return new FileCredentialStore(options.file);
  }

  const available = await (options.probeKeyring ?? defaultProbe(platform))();
  if (!available) {
    if (backend === 'keyring') {
      throw new AuthError('No keyring is available in this environment.', {
        details: { platform },
        hint: 'Install “secret-tool” (libsecret) or use “--store file”.',
      });
    }
    options.log?.debug('keyring unavailable, falling back to the protected file', { platform });
    return new FileCredentialStore(options.file);
  }

  return new KeyringCredentialStore(platform);
}

/** Probe for the platform's keyring CLI. */
function defaultProbe(platform: NodeJS.Platform): () => Promise<boolean> {
  return async () => {
    const binary = platform === 'darwin' ? 'security' : 'secret-tool';
    try {
      await execFileAsync('which', [binary], { encoding: 'utf8' });
      return true;
    } catch {
      return false;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Where a resolved credential came from. */
export type CredentialSource = 'environment' | 'store' | 'config';

export interface ResolvedCredential {
  readonly value: string;
  readonly source: CredentialSource;
  /** The environment variable name or file involved, for diagnostics. */
  readonly detail: string;
}

/**
 * Resolve an API key for a provider.
 *
 * Order, highest priority first:
 *
 *   1. The environment variable named by `providers.<id>.apiKeyEnv`.
 *   2. The adapter's conventional variables (`GROQ_API_KEY`, …), which let a
 *      user who already exports one for another tool avoid re-entering it.
 *   3. The credential store.
 *
 * Environment first is deliberate: it is how CI and ephemeral environments pass
 * a secret, and it must be able to override a stale stored value.
 *
 * The returned value is not registered with the redactor here. Registration is
 * the caller's job, immediately after resolution and before any logging — see
 * `registerSecret` — so that a failure between the two cannot log the value.
 */
export async function resolveApiKey(options: {
  readonly providerId: string;
  readonly apiKeyEnv?: string | undefined;
  readonly conventionalEnvVars?: readonly string[];
  readonly store: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<ResolvedCredential | undefined> {
  const env = options.env ?? process.env;

  const fromEnv = readEnvKey(options.apiKeyEnv, env);
  if (fromEnv !== undefined) return fromEnv;

  for (const name of options.conventionalEnvVars ?? []) {
    const found = readEnvKey(name, env);
    if (found !== undefined) return found;
  }

  const stored = await options.store.get(options.providerId).catch(() => undefined);
  if (stored !== undefined && stored !== '') {
    return { value: stored, source: 'store', detail: options.store.describe() };
  }

  return undefined;
}

function readEnvKey(
  name: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedCredential | undefined {
  if (name === undefined || name === '') return undefined;
  const value = env[name];
  if (value === undefined || value.trim() === '') return undefined;
  return { value, source: 'environment', detail: name };
}

/** A display-safe description of a stored credential, e.g. `sk-…a1b2`. */
export function describeCredential(value: string): string {
  return maskTail(value);
}

/** Error raised when a provider needs a key and none is configured. */
export function missingCredentialError(providerId: string, envVars: readonly string[]): AuthError {
  const hint =
    envVars.length > 0
      ? `Run “freecode auth login ${providerId}”, or set ${envVars.join(' or ')}.`
      : `Run “freecode auth login ${providerId}”.`;
  return new AuthError(`No API key is configured for provider “${providerId}”.`, {
    details: { providerId, envVars },
    hint,
  });
}
