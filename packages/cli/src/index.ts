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
import readline from 'node:readline';

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

async function startInteractiveShell(): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n🚀 FreeCode CLI');
  console.log('─────────────────────────────────────────────────────────────────\n');

  const context = await defaultContext();

  async function showMenu(): Promise<void> {
    console.log('Options:');
    console.log('  1.  Run the coding agent');
    console.log('  2.  Configure providers');
    console.log('  3.  Set API keys');
    console.log('  4.  Start gateway server');
    console.log('  5.  Check environment (doctor)');
    console.log('  6.  Show configuration');
    console.log('  7.  Exit\n');

    const answer = await new Promise<string>((resolve) => {
      rl.question('Select an option [1-7]: ', resolve);
    });

    switch (answer.trim()) {
      case '1':
        rl.close();
        const runProgram = new Command();
        buildRunCommand(runProgram);
        console.log('\n💬 Run Agent');
        console.log('─────────────────────────────────────────────────────────────────\n');
        console.log('Enter your task below. Press Enter to start.\n');
        const task = await new Promise<string>((resolve) => {
          rl.question('Task: ', resolve);
        });
        await runProgram.parseAsync(['run', ...task.split(' ')]);
        break;
      case '2':
        console.log('\n🔧 Configure Providers');
        console.log('─────────────────────────────────────────────────────────────────\n');
        const providerProgram = new Command();
        buildProviderCommands(providerProgram);
        await providerProgram.parseAsync(['providers']);
        await showMenu();
        break;
      case '3':
        console.log('\n🔑 Set API Keys');
        console.log('─────────────────────────────────────────────────────────────────\n');
        const authProgram = new Command();
        buildAuthCommands(authProgram);
        await authProgram.parseAsync(['auth']);
        await showMenu();
        break;
      case '4':
        console.log('\n🌐 Start Gateway Server');
        console.log('─────────────────────────────────────────────────────────────────\n');
        console.log('Use command: freecode gateway:start\n');
        await showMenu();
        break;
      case '5':
        console.log('\n🏥 Check Environment');
        console.log('─────────────────────────────────────────────────────────────────\n');
        const doctorProgram = new Command();
        buildDoctorCommand(doctorProgram);
        await doctorProgram.parseAsync(['doctor']);
        await showMenu();
        break;
      case '6':
        console.log('\n📋 Configuration');
        console.log('─────────────────────────────────────────────────────────────────\n');
        const configProgram = new Command();
        buildConfigCommands(configProgram);
        await configProgram.parseAsync(['config', 'show']);
        await showMenu();
        break;
      case '7':
      case 'q':
      case 'exit':
        rl.close();
        console.log('\nGoodbye!\n');
        process.exit(0);
      default:
        console.log('\n❌ Invalid option. Please try again.\n');
        await showMenu();
    }
  }

  try {
    await showMenu();
    return ExitCode.Ok;
  } catch (error) {
    rl.close();
    throw error;
  }
}

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

  // Add interactive mode as default when no arguments
  program.allowUnknownOption(false);

  // Check if any arguments were provided (other than --version, --help, etc.)
  const hasArguments = process.argv.slice(2).some(arg => !arg.startsWith('-'));

  // `parseAsync` (not `parse`) is required: every command action is async, and
  // the synchronous parser does not await the returned promise, so a rejection
  // would surface as an unhandled rejection — a raw stack trace, bypassing the
  // redacted handler below.

  if (!hasArguments) {
    // Start interactive shell if no command arguments
    return await startInteractiveShell();
  }

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
