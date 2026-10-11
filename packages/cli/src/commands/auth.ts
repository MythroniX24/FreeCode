/**
 * `freecode auth` — manage BYOK credentials.
 *
 * Security discipline for this command:
 *
 *  - A key is accepted from stdin (pasted or piped) or `--keyring-file`, never
 *    from a command-line argument, because argv is visible in `ps` output and
 *    shell history. A terminal prompt reads the line *without echoing*.
 *  - `auth status` shows only whether a provider has a key (`present`/`missing`)
 *    and which backend holds it. `auth list` masks values via `describeCredential`.
 *    A key value is never printed by this command in any mode.
 *  - `auth logout` removes the stored value. There is no way to read a key back
 *    out of the store, by design.
 */

import type { Command } from 'commander';

import {
  assertValidProviderId,
  AuthError,
  BUILT_IN_PROVIDERS,
  createCredentialStore,
  describeCredential,
  InterruptedError,
  UsageError,
} from '@freecode/core';
import type { CredentialStore } from '@freecode/core';

import type { CliContext } from '../context.js';
import { resolveCliContext } from '../util.js';

export function buildAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage BYOK API keys.');

  auth
    .command('login <provider>')
    .description('Store an API key for a provider. Reads the key from stdin (never echoed).')
    .option('--store <backend>', 'credential backend: file or keyring')
    .action(async (providerId: string, opts: { store?: string }) => {
      const ctx = await resolveCliContext();
      await runLogin(ctx, providerId, {
        ...(opts.store === undefined ? {} : { backend: opts.store }),
      });
    });

  auth
    .command('status')
    .description(
      'Show which providers have a key stored and the backend in use (never the values).',
    )
    .action(async () => {
      const ctx = await resolveCliContext();
      await runStatus(ctx);
    });

  auth
    .command('list')
    .description('Show stored provider ids with masked key tails.')
    .action(async () => {
      const ctx = await resolveCliContext();
      await runList(ctx);
    });

  auth
    .command('logout <provider>')
    .description('Remove the stored API key for a provider.')
    .action(async (providerId: string) => {
      const ctx = await resolveCliContext();
      await runLogout(ctx, providerId);
    });
}

export async function runLogin(
  ctx: CliContext,
  providerId: string,
  options: { backend?: string } = {},
): Promise<void> {
  // Passing a provider id through to the keyring/file backend can escape the
  // store's namespace; validate it the same way the store does. This is done
  // even for unknown ids, which are still supported: the key is simply stored
  // under that id, and the strict pattern keeps it inside the namespace.
  assertValidProviderId(providerId);

  const store = await storeFor(ctx, options.backend);
  const value = await readSecret('Paste the API key for this provider (hidden):\n> ');
  if (value === '') {
    throw new UsageError('No key was entered.');
  }

  await store.set(providerId, value);
  console.log(`✓ Stored a credential for ${providerId}.`);
  console.log(`  Backend: ${store.describe()}.`);
}

export async function runStatus(ctx: CliContext): Promise<void> {
  const stored = new Set(await ctx.store.list());
  console.log(`Credential backend: ${ctx.store.describe()}`);
  for (const builtIn of BUILT_IN_PROVIDERS) {
    const has = stored.has(builtIn.id);
    const marker = has ? '✓' : '·';
    console.log(
      `  ${marker} ${builtIn.id.padEnd(12)} ${has ? 'key present' : 'no key'}${builtIn.requiresApiKey ? '' : '  (keyless)'}`,
    );
  }
}

/**
 * `auth list` — show which ids have a stored key, and only the masked tail
 * (`sk-a1b2…c3d4`). The full value is never displayed by this command.
 */
export async function runList(ctx: CliContext): Promise<void> {
  const ids = await ctx.store.list();
  if (ids.length === 0) {
    console.log('No credentials stored. Run “freecode auth login <provider>” to add one.');
    return;
  }
  const backend = ctx.store.describe();
  for (const id of ids) {
    const value = await ctx.store.get(id);
    const masked = value === undefined ? '(unreadable)' : describeCredential(value);
    console.log(`  ${id.padEnd(12)} ${masked}  (${backend})`);
  }
}

export async function runLogout(ctx: CliContext, providerId: string): Promise<void> {
  assertValidProviderId(providerId);
  const removed = await ctx.store.delete(providerId);
  if (!removed) {
    throw new AuthError(`No stored credential for ${providerId}.`, {
      hint: 'Nothing to remove.',
    });
  }
  console.log(`✓ Removed the credential for ${providerId}.`);
}

/** Resolve a credential store, honouring `--store file|keyring`. */
async function storeFor(ctx: CliContext, backend: string | undefined): Promise<CredentialStore> {
  if (backend === undefined || backend === 'auto') return ctx.store;
  if (backend === 'file' || backend === 'keyring') {
    return createCredentialStore({ backend });
  }
  throw new UsageError(`Unknown credential backend “${backend}”.`, {
    hint: 'Use `--store file` or `--store keyring`.',
  });
}

/**
 * Read one line of secret input.
 *
 * When stdin is a TTY, echo is suppressed at the terminal-driver level by
 * enabling raw mode for the duration of the read (the same mechanism `sudo`
 * uses). Backspace edits the buffer; Ctrl+C cancels and restores the terminal.
 * When stdin is a pipe (`echo $KEY | freecode auth login`), raw mode cannot be
 * used and echo is irrelevant — the value was already produced by the caller,
 * so it is read as-is from the pipe. A non-TTY is never an error.
 */
async function readSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY !== true) {
    return readLineFromStdin(prompt);
  }
  return readSecretTty(prompt);
}

/** Read one line from a non-TTY stdin (a pipe or redirect). */
function readLineFromStdin(prompt: string): Promise<string> {
  // No prompt: the calling shell already knows a key is being piped, and a
  // stray line on stderr would break scripts. Only a live TTY gets the label.
  void prompt;
  process.stderr.write('');
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.resume();
    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      const newline = buf.indexOf(0x0a);
      if (newline === -1) {
        chunks.push(buf);
        return;
      }
      chunks.push(buf.subarray(0, newline));
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    process.stdin.on('data', onData);
    process.stdin.on('error', (error: Error) => {
      process.stdin.removeListener('data', onData);
      reject(error);
    });
  });
}

/** Read a hidden line from a TTY using raw mode for no-echo input. */
function readSecretTty(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const input = process.stdin;
    const restore = () => {
      input.pause();
      input.removeListener('data', onData);
      input.removeListener('error', onError);
    };
    // After raw mode, restore before resolving so no later prompt is affected.
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false);
          restore();
          process.stderr.write('\n');
          resolve(buffer);
          return;
        }
        if (char === '\x7f' || char === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (char === '\x03') {
          // Ctrl+C during the prompt: restore the terminal and abort.
          input.setRawMode(false);
          restore();
          process.stderr.write('\n');
          reject(new InterruptedError('Cancelled.'));
          return;
        }
        // Some paste handlers include CR first; a lone CR mid-paste is unlikely.
        buffer += char;
      }
    };
    const onError = (error: Error) => {
      try {
        input.setRawMode(false);
      } catch {
        // Already restored.
      }
      restore();
      reject(error);
    };
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.on('error', onError);
  });
}
