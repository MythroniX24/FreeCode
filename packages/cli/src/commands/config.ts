/**
 * `freecode config` — inspect and edit configuration.
 *
 * Security is the load-bearing behaviour here:
 *
 *  - `show` renders through the redactor, so an api key that somehow reached
 *    config (it should only ever be a variable name) is masked, never echoed.
 *  - `get` returns one dotted path.
 *  - `set` patches the *raw* user config file, validates the result against the
 *    schema, and writes atomically under 0600. A value that fails validation is
 *    rejected before anything is written.
 *
 * Every write re-reads and re-patches the current file rather than assuming the
 * state this process loaded, so concurrent edits are not clobbered silently.
 */

import type { Command } from 'commander';

import {
  ConfigError,
  getAtPath,
  redactConfigForDisplay,
  setAtPath,
  UsageError,
  withDefaults,
} from '@freecode/core';

import type { CliContext } from '../context.js';
import { resolveCliContext } from '../util.js';
import { readUserConfig, writeUserConfig } from '../userconfig.js';

export function buildConfigCommands(program: Command): void {
  const config = program.command('config').description('Inspect and edit configuration.');

  config
    .command('show')
    .description('Show the merged configuration with secret-shaped values redacted.')
    .action(async () => {
      const ctx = await resolveCliContext();
      // The redactor is the whole point of this command: a key must never print
      // raw even when the user explicitly asks to see config.
      await runShow(ctx);
    });

  config
    .command('get <path>')
    .description('Read one dotted config path, e.g. `providers.groq.baseUrl`.')
    .action(async (target: string) => {
      const ctx = await resolveCliContext();
      await runGet(ctx, target);
    });

  config
    .command('set <path> <value>')
    .description('Set one dotted config path atomically, after validating the patched config.')
    .action(async (target: string, rawValue: string) => {
      const ctx = await resolveCliContext();
      await runSet(ctx, target, coerce(rawValue));
    });
}

export async function runShow(ctx: CliContext): Promise<void> {
  // The redactor is the whole point of this command: a key must never print raw
  // even when the user explicitly asks to see config.
  console.log(JSON.stringify(redactConfigForDisplay(ctx.config.config), null, 2));
}

export async function runGet(ctx: CliContext, target: string): Promise<void> {
  const value = getAtPath(ctx.config.config, target);
  if (value === undefined) {
    throw new UsageError(`No such config path: ${target}`);
  }
  console.log(JSON.stringify(value, null, 2));
}

export async function runSet(ctx: CliContext, target: string, value: unknown): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(target)) {
    throw new UsageError(`Invalid config path “${target}”.`, {
      hint: 'Dotted paths contain letters, digits, dashes, dots and underscores only.',
    });
  }

  // Re-read the current raw user config rather than trusting the loaded one.
  const raw = (await readUserConfig()) as Record<string, unknown>;
  setAtPath(raw, target, value);

  // Validate the *patched* object. An invalid write is rejected loudly before
  // any file mutation; `withDefaults` applies the schema defaults so a valid
  // patch is round-trippable.
  try {
    withDefaults(raw);
  } catch (error) {
    throw new ConfigError(
      `Refusing to write an invalid value for “${target}”: ${(error as Error).message}`,
      {
        hint: 'Run “freecode config show” to inspect the current value.',
      },
    );
  }

  await writeUserConfig(raw);
  console.log(`Set ${target}`);
}

function coerce(value: string): unknown {
  const trimmed = value.trim();
  if (/^(?:true|false|1|0|yes|no|on|off)$/i.test(trimmed))
    return /^(?:true|1|yes|on)$/i.test(trimmed);
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d*\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  return trimmed;
}
