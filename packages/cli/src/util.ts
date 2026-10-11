/**
 * Shared CLI utilities.
 *
 * `resolveCliContext` builds the per-invocation context every command needs:
 * the merged config, a real credential store, and a logger. It is the one place
 * that composes the dependency-free pieces from `@freecode/core`; command
 * modules take a ready `CliContext` so they remain testable with a stubbed one.
 */

import { createCredentialStore, loadConfig, Logger, streamSink } from '@freecode/core';
import type { CredentialStore, LoadedConfig } from '@freecode/core';

import type { CliContext } from './context.js';

export interface ResolveContextOptions {
  readonly cwd?: string;
  /** Skip reading project config (`--no-project-config`). */
  readonly ignoreProjectConfig?: boolean;
  readonly log?: Logger;
}

export async function resolveCliContext(options: ResolveContextOptions = {}): Promise<CliContext> {
  const cwd = options.cwd ?? process.cwd();
  const config: LoadedConfig = await loadConfig({
    cwd,
    ...(options.ignoreProjectConfig === undefined
      ? {}
      : { ignoreProjectConfig: options.ignoreProjectConfig }),
  });
  const logger = options.log ?? new Logger({ level: 'info', sink: streamSink(process.stderr) });
  const store: CredentialStore = await createCredentialStore({
    log: logger,
  }).catch((error: unknown) => {
    // A broken credential store must never take down `freecode config show`, so
    // fall back to an in-memory store that reports empty rather than failing.
    logger.warn(`Could not open the credential store: ${(error as Error).message}`);
    return memoryStore();
  });

  return { config, store, logger, cwd };
}

/** In-memory store used when the real backend cannot be opened. */
function memoryStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    backend: 'file',
    secure: false,
    describe: () => '(unopened)',
    async get(id: string) {
      return values.get(id);
    },
    async set(id: string, value: string) {
      values.set(id, value);
    },
    async delete(id: string) {
      return values.delete(id);
    },
    async list() {
      return [...values.keys()];
    },
  };
}
