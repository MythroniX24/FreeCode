/**
 * Credential store tests.
 *
 * The store is where a secret is most likely to escape, so the assertions here
 * are deliberately adversarial: they check file permissions on the real
 * filesystem, they check that a failed write cannot destroy existing entries,
 * and they exercise the keyring backend through a *real* child process so the
 * claim "the value is passed as an argument and never through a shell" is
 * verified rather than asserted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AuthError } from '../src/errors.js';
import {
  FileCredentialStore,
  KeyringCredentialStore,
  createCredentialStore,
  describeCredential,
  missingCredentialError,
  resolveApiKey,
  type CredentialStore,
} from '../src/auth/store.js';
import { cleanupTempDirs, makeTempDir } from './helpers/fs.js';

let root: string;
let storePath: string;

beforeEach(async () => {
  root = await makeTempDir('auth-');
  storePath = path.join(root, 'data', 'credentials.json');
});

afterEach(async () => {
  await cleanupTempDirs();
});

describe('FileCredentialStore', () => {
  it('stores and reads a value', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'gsk-secret-value');
    expect(await store.get('groq')).toBe('gsk-secret-value');
  });

  it('returns undefined for an absent provider', async () => {
    const store = new FileCredentialStore(storePath);
    expect(await store.get('never-set')).toBeUndefined();
  });

  it('creates the file with mode 0600', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'value');
    const info = await stat(storePath);
    // 0o777 masks off the file-type bits, leaving the permission bits.
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('creates the containing directory with mode 0700', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'value');
    const info = await stat(path.dirname(storePath));
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('tightens a directory that already existed with looser permissions', async () => {
    // `mkdir` does not change an existing directory's mode, so a store created
    // over a world-readable `~/.config/freecode` would otherwise stay readable.
    await mkdir(path.dirname(storePath), { recursive: true, mode: 0o755 });
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'value');
    const info = await stat(path.dirname(storePath));
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('re-tightens the file when it already existed with looser permissions', async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, '{}', { encoding: 'utf8', mode: 0o644 });
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'value');
    const info = await stat(storePath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('keeps several providers independent', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'a');
    await store.set('cerebras', 'b');
    expect(await store.get('groq')).toBe('a');
    expect(await store.get('cerebras')).toBe('b');
  });

  it('overwrites an existing value', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'old');
    await store.set('groq', 'new');
    expect(await store.get('groq')).toBe('new');
  });

  it('preserves other entries when one is updated', async () => {
    // The whole file is rewritten on every set, so a merge bug here would drop
    // every other credential the user had stored.
    const store = new FileCredentialStore(storePath);
    await store.set('a', '1');
    await store.set('b', '2');
    await store.set('c', '3');
    await store.set('b', 'updated');
    expect(await store.list()).toEqual(['a', 'b', 'c']);
    expect(await store.get('a')).toBe('1');
    expect(await store.get('c')).toBe('3');
  });

  it('deletes a value', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'v');
    expect(await store.delete('groq')).toBe(true);
    expect(await store.get('groq')).toBeUndefined();
  });

  it('reports deleting an absent value as false', async () => {
    const store = new FileCredentialStore(storePath);
    expect(await store.delete('nope')).toBe(false);
  });

  it('lists provider ids only, never values', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'super-secret');
    await store.set('openai', 'another-secret');
    const listed = await store.list();
    expect(listed).toEqual(['groq', 'openai']);
    expect(JSON.stringify(listed)).not.toContain('secret');
  });

  it('lists ids in a stable order regardless of insertion order', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('zeta', '1');
    await store.set('alpha', '2');
    expect(await store.list()).toEqual(['alpha', 'zeta']);
  });

  it('refuses to store an empty credential', async () => {
    const store = new FileCredentialStore(storePath);
    await expect(store.set('groq', '')).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a provider id that could escape the namespace', async () => {
    const store = new FileCredentialStore(storePath);
    for (const bad of ['../escape', 'has space', 'a/b', '', 'x'.repeat(100)]) {
      await expect(store.set(bad, 'v'), bad).rejects.toBeInstanceOf(AuthError);
    }
  });

  it('validates the provider id on reads too, not only on writes', async () => {
    // A traversal-shaped id must not reach the file map at all, even for a
    // lookup that would have returned undefined.
    const store = new FileCredentialStore(storePath);
    await expect(store.get('../../etc/passwd')).rejects.toBeInstanceOf(AuthError);
    await expect(store.delete('../../etc/passwd')).rejects.toBeInstanceOf(AuthError);
  });

  it('treats an absent file as empty rather than an error', async () => {
    const store = new FileCredentialStore(path.join(root, 'nothing', 'here.json'));
    expect(await store.list()).toEqual([]);
  });

  it('treats an empty file as empty', async () => {
    const file = path.join(root, 'empty.json');
    await writeFile(file, '   \n', 'utf8');
    const store = new FileCredentialStore(file);
    expect(await store.list()).toEqual([]);
  });

  it('reports corrupt JSON without echoing the file contents', async () => {
    const file = path.join(root, 'bad.json');
    await writeFile(file, '{ "provider:groq": "sk-LEAKME"', 'utf8');
    const store = new FileCredentialStore(file);
    const error = await store.list().catch((e: unknown) => e as AuthError);
    expect(error).toBeInstanceOf(AuthError);
    // The corrupt file may contain a key; the error is printed, so it must not.
    expect((error as AuthError).message).not.toContain('LEAKME');
    expect((error as AuthError).hint).not.toContain('LEAKME');
  });

  it('rejects a JSON array as the root', async () => {
    const file = path.join(root, 'arr.json');
    await writeFile(file, '[1,2]', 'utf8');
    const store = new FileCredentialStore(file);
    await expect(store.list()).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a JSON scalar as the root', async () => {
    const file = path.join(root, 'scalar.json');
    await writeFile(file, '"just a string"', 'utf8');
    const store = new FileCredentialStore(file);
    await expect(store.list()).rejects.toBeInstanceOf(AuthError);
  });

  it('ignores non-string values in the file', async () => {
    const file = path.join(root, 'mixed.json');
    await writeFile(file, JSON.stringify({ 'provider:good': 'v', 'provider:bad': 42 }), 'utf8');
    const store = new FileCredentialStore(file);
    expect(await store.list()).toEqual(['good']);
    expect(await store.get('bad')).toBeUndefined();
  });

  it('preserves unrelated keys it does not understand', async () => {
    // Forward compatibility: a newer version's key must survive a write from
    // this one rather than being silently dropped.
    const file = path.join(root, 'future.json');
    await writeFile(file, JSON.stringify({ 'future:thing': 'keep-me' }), 'utf8');
    const store = new FileCredentialStore(file);
    await store.set('groq', 'v');
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    expect(raw['future:thing']).toBe('keep-me');
  });

  it('leaves no temporary file behind after a write', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'v');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.dirname(storePath));
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('writes the value under a provider-prefixed key', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'v');
    const raw = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, string>;
    expect(Object.keys(raw)).toEqual(['provider:groq']);
  });

  it('round-trips a value containing quotes, newlines and unicode', async () => {
    const store = new FileCredentialStore(storePath);
    const awkward = 'sk-"quoted"\\slash\nnewline\tünïcødé⏎';
    await store.set('groq', awkward);
    expect(await store.get('groq')).toBe(awkward);
  });

  it('reports itself as not secure, and says why', () => {
    const store = new FileCredentialStore(storePath);
    expect(store.backend).toBe('file');
    expect(store.secure).toBe(false);
    // The description is shown to the user, so it must be honest about the risk.
    expect(store.describe()).toMatch(/plaintext/);
    expect(store.describe()).toContain(storePath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Keyring backend, driven through a real child process
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fake `secret-tool` implemented in Node and invoked as a genuine child
 * process via `process.execPath`. Going through `execFile` for real is the point:
 * a test that stubbed the exec call would verify nothing about how arguments
 * actually reach a binary, which is exactly the property under test.
 */
const FAKE_KEYRING_SOURCE = `
const { readFileSync, writeFileSync, rmSync, readdirSync, existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const verb = process.argv[3];
const args = process.argv.slice(4);
const accountIndex = args.indexOf('account');
const id = accountIndex >= 0 ? args[accountIndex + 1] : '';
switch (verb) {
  case 'lookup': {
    const file = path.join(dir, id);
    if (!existsSync(file)) process.exit(1);
    process.stdout.write(readFileSync(file, 'utf8'));
    break;
  }
  case 'store': {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, id), args[args.length - 1]);
    break;
  }
  case 'clear': {
    rmSync(path.join(dir, id), { force: true });
    break;
  }
  case 'search': {
    if (existsSync(dir)) for (const name of readdirSync(dir)) process.stdout.write('account: ' + name + '\\n');
    break;
  }
  default:
    // Diagnostic on stderr, never stdout: stdout is what the store parses as
    // the value, so writing a failure there would look like a stored key.
    process.stderr.write('unknown verb\\n');
    process.exit(2);
}
`;

describe('KeyringCredentialStore', () => {
  let keyringDir: string;
  let script: string;

  /**
   * The service name is not exported from the module, and the fake does not need
   * it: it parses the `account` attribute out of the argument vector, so any
   * service name works. The fake's "binary" is the Node runtime with the script
   * as its first argument, which avoids depending on shebang handling or the
   * executable bit on any particular filesystem — neither of which is reliable
   * on the FUSE mounts this project targets.
   */
  const SERVICE = 'freecode';

  beforeEach(async () => {
    keyringDir = path.join(root, 'keyring');
    script = path.join(root, 'fake-keyring.cjs');
    await writeFile(script, FAKE_KEYRING_SOURCE, 'utf8');
    await chmod(script, 0o600);
  });

  function keyring(): KeyringCredentialStore {
    // The temp directory is passed positionally, so no environment variable
    // needs to be plumbed through `execFile`.
    return new KeyringCredentialStore('linux', {
      binary: process.execPath,
      read: (id) => [script, keyringDir, 'lookup', 'service', SERVICE, 'account', id],
      write: (id, value) => [
        script,
        keyringDir,
        'store',
        '--label',
        'x',
        'service',
        SERVICE,
        'account',
        id,
        value,
      ],
      remove: (id) => [script, keyringDir, 'clear', 'service', SERVICE, 'account', id],
      list: () => [script, keyringDir, 'search', '--unlock', 'service', SERVICE],
    });
  }

  it('stores and reads a value through the child process', async () => {
    const store = keyring();
    await store.set('groq', 'gsk-value');
    expect(await store.get('groq')).toBe('gsk-value');
  });

  it('returns undefined for an entry the keyring does not have', async () => {
    // A missing entry is a "not found" exit status, not an error: a user who has
    // never logged in must see an empty status, not a crash.
    const store = keyring();
    expect(await store.get('absent')).toBeUndefined();
  });

  it('passes a shell-metacharacter value through byte-for-byte', async () => {
    // The load-bearing property of the whole backend. If the value were ever
    // interpolated into a shell string, this value would either be mangled or
    // executed; reaching the file unchanged proves it was passed as an argument.
    const store = keyring();
    const dangerous = 'sk-a b;rm -rf /$(whoami)`id`"q"\'q\' & | > out < in *';
    await store.set('groq', dangerous);
    expect(await store.get('groq')).toBe(dangerous);
  });

  it('does not expand a glob or a variable in the stored value', async () => {
    const store = keyring();
    await store.set('groq', '$HOME*');
    const onDisk = await readFile(path.join(keyringDir, 'groq'), 'utf8');
    expect(onDisk).toBe('$HOME*');
  });

  it('removes an entry', async () => {
    const store = keyring();
    await store.set('groq', 'v');
    expect(await store.delete('groq')).toBe(true);
    expect(await store.get('groq')).toBeUndefined();
  });

  it('lists the accounts the keyring holds', async () => {
    const store = keyring();
    await store.set('openai', 'a');
    await store.set('groq', 'b');
    expect(await store.list()).toEqual(['groq', 'openai']);
  });

  it('returns an empty list rather than guessing when the listing is unreadable', async () => {
    // Reporting a provider as configured when it is not would send the user
    // chasing a phantom credential.
    const store = new KeyringCredentialStore('linux', {
      binary: process.execPath,
      read: () => [script],
      write: () => [script],
      remove: () => [script],
      list: () => [path.join(root, 'does-not-exist.cjs')],
    });
    expect(await store.list()).toEqual([]);
  });

  it('refuses to store an empty credential', async () => {
    const store = keyring();
    await expect(store.set('groq', '')).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an invalid provider id before running the binary', async () => {
    const store = keyring();
    await expect(store.set('../escape', 'v')).rejects.toBeInstanceOf(AuthError);
    await expect(store.get('../escape')).rejects.toBeInstanceOf(AuthError);
    await expect(store.delete('../escape')).rejects.toBeInstanceOf(AuthError);
    // Nothing was created: the guard fired first.
    expect(await store.list()).toEqual([]);
  });

  it('surfaces a keyring failure without reproducing the credential', async () => {
    // The load-bearing assertion of the whole backend. `execFile`'s own error
    // message is `Command failed: <binary> <args…>` — and for the `store` verb
    // the args *are* the key — so a naive implementation puts the secret into
    // the terminal and into any log that captured the error. The fake is asked
    // to fail on a verb that carries the value, which is the worst case.
    const store = new KeyringCredentialStore('linux', {
      binary: process.execPath,
      read: () => [script, keyringDir, 'dos-not-exist'],
      write: () => [script, keyringDir, 'unknown-verb', 'account', 'groq', 'sk-LEAKME'],
      remove: () => [script, keyringDir, 'dos-not-exist'],
      list: () => [script, keyringDir, 'dos-not-exist'],
    });
    const error = await store.set('groq', 'sk-LEAKME').catch((e: unknown) => e as AuthError);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain('keyring');
    expect((error as AuthError).message).not.toContain('LEAKME');
    expect((error as AuthError).hint).not.toContain('LEAKME');
    // Guard against a future change that starts attaching the raw failure.
    expect(JSON.stringify((error as AuthError).details ?? {})).not.toContain('LEAKME');
  });

  it('reports a failed read without reproducing the command line', async () => {
    const store = new KeyringCredentialStore('linux', {
      binary: process.execPath,
      read: () => [script, keyringDir, 'unknown-verb', 'account', 'groq'],
      write: () => [script],
      remove: () => [script],
      list: () => [script],
    });
    const error = await store.get('groq').catch((e: unknown) => e as AuthError);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).not.toContain(keyringDir);
  });

  it('names the missing binary when the keyring CLI is not installed', async () => {
    const store = new KeyringCredentialStore('linux', {
      binary: path.join(root, 'no-such-binary'),
      read: () => [],
      write: () => [],
      remove: () => [],
      list: () => [],
    });
    const error = await store.get('groq').catch((e: unknown) => e as AuthError);
    expect((error as AuthError).message).toMatch(/ENOENT|no-such-binary/);
  });

  it('reports itself as secure and names the backing store', () => {
    expect(keyring().backend).toBe('keyring');
    expect(keyring().secure).toBe(true);
    expect(keyring().describe()).toMatch(/Secret Service/);
    expect(new KeyringCredentialStore('darwin').describe()).toMatch(/Keychain/);
  });

  it('refuses to construct on a platform with no keyring command', () => {
    // Better a clear refusal than a store that silently cannot persist.
    expect(() => new KeyringCredentialStore('win32')).toThrow(AuthError);
  });
});

describe('createCredentialStore', () => {
  it('falls back to the file backend when the keyring probe fails', async () => {
    const store = await createCredentialStore({
      platform: 'linux',
      probeKeyring: async () => false,
      file: storePath,
    });
    expect(store.backend).toBe('file');
  });

  it('uses the keyring when the probe succeeds', async () => {
    const store = await createCredentialStore({
      platform: 'linux',
      probeKeyring: async () => true,
      file: storePath,
    });
    expect(store.backend).toBe('keyring');
    expect(store.secure).toBe(true);
  });

  it('refuses to pretend a keyring exists when one is demanded', async () => {
    const error = await createCredentialStore({
      platform: 'linux',
      backend: 'keyring',
      probeKeyring: async () => false,
    }).catch((e: unknown) => e as AuthError);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).hint).toMatch(/--store file/);
  });

  it('falls back to a file on a platform with no supported keyring', async () => {
    const store = await createCredentialStore({ platform: 'win32', file: storePath });
    expect(store.backend).toBe('file');
  });

  it('says plainly that Windows storage is unavailable when forced', async () => {
    const error = await createCredentialStore({ platform: 'win32', backend: 'keyring' }).catch(
      (e: unknown) => e as AuthError,
    );
    expect((error as AuthError).message).toMatch(/native module/i);
  });

  it('honours an explicit file backend even where a keyring exists', async () => {
    const store = await createCredentialStore({
      platform: 'darwin',
      backend: 'file',
      file: storePath,
    });
    expect(store.backend).toBe('file');
    await store.set('groq', 'v');
    expect(await store.get('groq')).toBe('v');
  });

  it('does not probe at all when the file backend is forced', async () => {
    let probed = false;
    await createCredentialStore({
      platform: 'linux',
      backend: 'file',
      file: storePath,
      probeKeyring: async () => {
        probed = true;
        return true;
      },
    });
    expect(probed).toBe(false);
  });
});

describe('resolveApiKey', () => {
  it('prefers the configured environment variable', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'from-store');
    const resolved = await resolveApiKey({
      providerId: 'groq',
      apiKeyEnv: 'MY_GROQ_KEY',
      store,
      env: { MY_GROQ_KEY: 'from-env' },
    });
    expect(resolved).toMatchObject({
      value: 'from-env',
      source: 'environment',
      detail: 'MY_GROQ_KEY',
    });
  });

  it('falls back to a conventional variable', async () => {
    // A user who already exports GROQ_API_KEY for another tool should not have
    // to re-enter it.
    const store = new FileCredentialStore(storePath);
    const resolved = await resolveApiKey({
      providerId: 'groq',
      conventionalEnvVars: ['GROQ_API_KEY'],
      store,
      env: { GROQ_API_KEY: 'conventional' },
    });
    expect(resolved).toMatchObject({ value: 'conventional', source: 'environment' });
  });

  it('prefers the configured variable over a conventional one', async () => {
    const store = new FileCredentialStore(storePath);
    const resolved = await resolveApiKey({
      providerId: 'groq',
      apiKeyEnv: 'EXPLICIT',
      conventionalEnvVars: ['GROQ_API_KEY'],
      store,
      env: { EXPLICIT: 'right', GROQ_API_KEY: 'wrong' },
    });
    expect(resolved?.value).toBe('right');
  });

  it('falls back to the store', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'stored-value');
    const resolved = await resolveApiKey({ providerId: 'groq', store, env: {} });
    expect(resolved).toMatchObject({ value: 'stored-value', source: 'store' });
  });

  it('lets the environment override a stored value', async () => {
    // CI and ephemeral environments pass secrets this way and must win over a
    // stale value left on disk.
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'stale');
    const resolved = await resolveApiKey({
      providerId: 'groq',
      apiKeyEnv: 'K',
      store,
      env: { K: 'fresh' },
    });
    expect(resolved?.value).toBe('fresh');
  });

  it('returns undefined when nothing is configured', async () => {
    const store = new FileCredentialStore(storePath);
    expect(await resolveApiKey({ providerId: 'groq', store, env: {} })).toBeUndefined();
  });

  it('ignores an empty or whitespace-only environment variable', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('groq', 'stored');
    expect(
      (await resolveApiKey({ providerId: 'groq', apiKeyEnv: 'K', store, env: { K: '   ' } }))
        ?.value,
    ).toBe('stored');
    expect(
      (await resolveApiKey({ providerId: 'groq', apiKeyEnv: 'K', store, env: { K: '' } }))?.value,
    ).toBe('stored');
  });

  it('does not fail when the store itself errors', async () => {
    // A provider with a key in the environment must work even if the credential
    // file is unreadable; the failure is confined to the path that needs it.
    const brokenStore: CredentialStore = {
      backend: 'file',
      secure: false,
      describe: () => 'broken',
      get: async () => {
        throw new AuthError('unreadable');
      },
      set: async () => undefined,
      delete: async () => false,
      list: async () => [],
    };
    expect(
      await resolveApiKey({ providerId: 'groq', store: brokenStore, env: {} }),
    ).toBeUndefined();
    expect(
      (
        await resolveApiKey({
          providerId: 'groq',
          apiKeyEnv: 'K',
          store: brokenStore,
          env: { K: 'env-wins' },
        })
      )?.value,
    ).toBe('env-wins');
  });

  it('does not fall back to another provider’s stored key', async () => {
    const store = new FileCredentialStore(storePath);
    await store.set('openai', 'openai-key');
    expect(await resolveApiKey({ providerId: 'groq', store, env: {} })).toBeUndefined();
  });
});

describe('describeCredential', () => {
  it('masks the value, keeping only a short tail', async () => {
    const { maskTail } = await import('../src/util/redact.js');
    const shown = describeCredential('gsk-1234567890abcde');
    expect(shown).not.toContain('1234567890');
    expect(shown).toBe(maskTail('gsk-1234567890abcde'));
  });

  it('fully redacts a value too short to mask safely', () => {
    expect(describeCredential('short')).not.toContain('short');
  });
});

describe('missingCredentialError', () => {
  it('names the provider and every variable that would work', () => {
    const error = missingCredentialError('groq', ['GROQ_API_KEY', 'GROQ_KEY']);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).toContain('groq');
    expect(error.hint).toContain('GROQ_API_KEY');
    expect(error.hint).toContain('GROQ_KEY');
    expect(error.exitCode).toBeGreaterThan(0);
  });

  it('suggests the login command when no variables are known', () => {
    expect(missingCredentialError('custom', []).hint).toContain('freecode auth login custom');
  });
});
