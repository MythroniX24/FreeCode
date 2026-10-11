/**
 * Per-invocation CLI context.
 *
 * The commands are plain functions that take a `CliContext`, which carries the
 * resolved config, the credential store, a logger, and the parsed CLI flags that
 * affect behaviour (output format, debug). Keeping context out of module state
 * is what lets the same command code run under tests with a redirected cache,
 * a temp config, and a stub store.
 */

import type { CredentialStore, LoadedConfig, Logger } from '@freecode/core';
import { nullLogger } from '@freecode/core';

export interface CliContext {
  /** Full merged config. */
  readonly config: LoadedConfig;
  /** Resolved credential store (backing `auth`). Never holds the value itself. */
  readonly store: CredentialStore;
  readonly logger: Logger;
  readonly cwd: string;
}

export function defaultContext(options: Partial<CliContext> = {}): CliContext {
  const logger = options.logger ?? nullLogger();
  return {
    config: options.config ?? ({ config: {}, issues: [] } as never),
    store: options.store as CredentialStore,
    logger,
    cwd: options.cwd ?? process.cwd(),
  };
}
