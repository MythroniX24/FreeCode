#!/usr/bin/env node
/**
 * FreeCode CLI — free, BYOK-first AI coding agent for the terminal.
 *
 * Distribution-grade concerns handled here:
 *
 *  - The entrypoint is a thin shell: argparse, top-level error mapping to the
 *    documented exit codes, and signal handling. Everything semantic lives in a
 *    command module.
 *  - A fatal error is printed *redacted*, never with a raw message: a provider
 *    error body could echo a credential back, and the redactor is the last line
 *    of defence against it reaching the terminal.
 *  - Secrets are never traded through the CLI surface. `config show` and
 *    `doctor` render redacted values by default and have no `--json` escape that
 *    dumps raw keys.
 */

import { Command } from 'commander';

import { VERSION } from '@freecode/core';
import { ExitCode, isAbortError, toFreecodeError } from '@freecode/core';
import { redact } from '@freecode/core';
import {
  buildProviderCommands,
  buildAuthCommands,
  buildConfigCommands,
  buildModelCommands,
  buildDoctorCommand,
  buildRunCommand,
} from './commands/index.js';
import { defaultContext, type CliContext } from './context.js';

async function main(): Promise<number> {
  const program = new Command();
  program
    .name('freecode')
    .description('FreeCode — a free, BYOK-first AI coding agent for the terminal.')
    .version(VERSION);

  buildProviderCommands(program);
  buildAuthCommands(program);
  buildConfigCommands(program);
  buildModelCommands(program);
  buildDoctorCommand(program);
  buildRunCommand(program);

  // `parseAsync` (not `parse`) is required: every command action is async, and
  // the synchronous parser does not await the returned promise, so a rejection
  // would surface as an unhandled rejection — a raw stack trace, bypassing the
  // redacted handler below.
  await program.parseAsync(process.argv);

  // A command action may set `process.exitCode` to signal a partial failure
  // (e.g. `models refresh` when one provider is unreachable). Returning a bare
  // `ExitCode.Ok` here would have the caller overwrite it and mask the failure,
  // so the code the actions chose is preserved when there is one.
  return typeof process.exitCode === 'number' ? process.exitCode : ExitCode.Ok;
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (isAbortError(error)) {
      process.exitCode = ExitCode.Interrupted;
      return;
    }
    const freecodeError = toFreecodeError(error);
    // The redactor is the last defence: a provider can echo a credential into an
    // error body, and no raw message is allowed to reach the terminal.
    process.stderr.write(`error: ${redact(freecodeError.message)}\n`);
    if (freecodeError.hint !== undefined) {
      process.stderr.write(`hint: ${redact(freecodeError.hint)}\n`);
    }
    process.exitCode = freecodeError.exitCode;
  });

export type { CliContext };
export { defaultContext };
