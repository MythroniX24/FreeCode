/**
 * Read + atomic-write of the *raw* user config file.
 *
 * Both `config set` and `providers add` edit the user's authored config rather
 * than the resolved one, so they share this one implementation — one definition
 * of the missing-file default, one atomic-write path, one pair of permission
 * modes. A config edit is a write to the user's filesystem; the path is
 * re-derived from the `@freecode/core` helper rather than remembered, and the
 * temporary file is created under 0600 in a 0700 directory.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ConfigError, userConfigPath } from '@freecode/core';

/** Read the raw user config object, treating a missing file as `{}`. */
export async function readUserConfig(): Promise<unknown> {
  try {
    const text = await fs.readFile(userConfigPath(), 'utf8');
    return JSON.parse(text) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    if (code === undefined) {
      // JSON.parse failure
      throw new ConfigError(`Cannot parse ${userConfigPath()}: ${(error as Error).message}`);
    }
    throw error;
  }
}

/** Atomically write the user config under mode 0600. */
export async function writeUserConfig(config: unknown): Promise<void> {
  const file = userConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.config.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}
