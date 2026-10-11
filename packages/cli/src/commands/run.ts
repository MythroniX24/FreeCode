/**
 * `freecode run "<task>"` — drive the agent against the workspace.
 *
 * This module is the seam between the agent kernel (which emits events and asks
 * for approvals) and the terminal (which renders them and answers). Keeping the
 * rendering here, out of the loop, is what lets the same loop be exercised by a
 * test with no terminal at all.
 *
 * Responsibilities, and nothing beyond them:
 *
 *  - **Assemble the dependencies.** Resolve the provider for the chosen model,
 *    build the tool context (guard, command policy, ignore matcher), wire a
 *    checkpoint manager, and pick an approver.
 *
 *  - **Render events** through an `AgentRenderer`, honouring the `output.*`
 *    config (diffs, tool activity, usage, colour).
 *
 *  - **Ask the user** when policy demands it, via a readline-based approver that
 *    offers once / always / never.
 *
 *  - **Map the outcome to an exit code** so a scripted caller can react: a clean
 *    finish is 0, a denial or budget stop is non-zero.
 */

import { createInterface } from 'node:readline';
import process from 'node:process';

import type { Command } from 'commander';
import {
  FileCheckpointManager,
  IgnoreMatcher,
  PathGuard,
  CommandPolicy,
  createTools,
  createProvider,
  runAgent,
  ALWAYS_IGNORED_PATTERNS,
  ExitCode,
  UsageError,
  configuredModelIds,
  identifyModel,
  unionRegistry,
  type AgentTool,
  type ApprovalRequest,
  type Approver,
  type ChatMessage,
  type ChatRequest,
  type FreecodeConfig,
} from '@freecode/core';

import type { CliContext } from '../context.js';
import { resolveCliContext } from '../util.js';
import { AgentRenderer } from '../render.js';

interface RunFlags {
  readonly model?: string;
  readonly provider?: string;
  readonly yes?: boolean;
  readonly prompt?: string;
}

export function buildRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run the coding agent against a task in the current workspace.')
    .argument('[task...]', 'the task, as words (or pass --prompt)')
    .option('-m, --model <reference>', 'model to use, as “provider/model”')
    .option('-p, --provider <id>', 'provider to use when the model does not name one')
    .option('-y, --yes', 'approve every action without prompting (dangerous)')
    .option('--prompt <text>', 'the task, when a single argument is inconvenient')
    .action(async (task: string[], flags: RunFlags) => {
      const ctx = await resolveCliContext();
      const prompt = flags.prompt ?? task.join(' ').trim();
      if (prompt === '') {
        throw new UsageError('No task given. Pass it as an argument or with --prompt.');
      }
      const code = await runTask(ctx, prompt, flags);
      if (code !== ExitCode.Ok) process.exitCode = code;
    });
}

/** Split a `provider/model` reference, or `undefined` when it has no slash. */
function splitReference(reference: string): { providerId: string; model: string } | undefined {
  const slash = reference.indexOf('/');
  if (slash <= 0) return undefined;
  return { providerId: reference.slice(0, slash), model: reference.slice(slash + 1) };
}

export async function runTask(ctx: CliContext, prompt: string, flags: RunFlags): Promise<number> {
  const config = ctx.config.config;
  const renderer = new AgentRenderer({
    output: config.output,
    write: (chunk) => process.stdout.write(chunk),
  });

  const selection = await selectModel(config, flags);
  const provider = await createProvider(selection.providerId, {
    config,
    store: ctx.store,
    log: ctx.logger,
  });

  const guard = await PathGuard.create({
    workspaceRoot: ctx.cwd,
    allowSensitiveReads: config.security.allowSensitiveReads,
    allowProtectedWrites: config.security.allowProtectedWrites,
  });

  const ignore = config.security.respectIgnoreFile ? await loadIgnore(ctx.cwd) : undefined;

  const tools = createTools({
    guard,
    commandPolicy: new CommandPolicy({
      autoApproveReadOnly: config.security.autoApproveReadOnly,
      trustedCommands: config.security.trustedCommands,
      deniedCommands: config.security.deniedCommands,
      allowNetworkCommands: config.security.allowNetworkCommands,
    }),
    ignore,
    config,
    logger: ctx.logger,
  });

  const checkpoints = config.agent.checkpoints
    ? new FileCheckpointManager({
        workspaceRoot: guard.workspaceRoot,
        maxCheckpoints: config.agent.maxCheckpoints,
        log: ctx.logger,
      })
    : undefined;

  const approver = makeApprover({ yes: flags.yes === true });

  const result = await runAgent(
    {
      chat: (request) => provider.provider.stream(toChatRequest(request, selection.model, config)),
      tools,
      config: config.agent,
      security: config.security,
      approval: config.approval,
      logger: ctx.logger,
      emit: (event) => renderer.render(event),
      approver,
      ...(checkpoints === undefined ? {} : { checkpoints }),
    },
    {
      prompt,
      model: selection.model,
      ...(config.security.sendWorkspaceContext
        ? { workspaceContext: await workspaceSummary(ctx.cwd, guard, ignore, config) }
        : {}),
    },
  );

  renderer.finish(result);
  return exitCodeFor(result.stopReason);
}

interface ModelSelection {
  readonly providerId: string;
  readonly model: string;
}

/**
 * Choose the provider and model.
 *
 * Precedence: an explicit `provider/model` reference, then `--model` with a
 * provider from `--provider` or the config default, then a bare `--model` id
 * resolved through stealth identification against the registry/config pins,
 * then the configured default provider and its first known model. Every
 * fallback is stated in the error rather than guessed at silently.
 */
async function selectModel(config: FreecodeConfig, flags: RunFlags): Promise<ModelSelection> {
  if (flags.model !== undefined) {
    const split = splitReference(flags.model);
    if (split !== undefined) return split;
    const providerId = flags.provider ?? config.defaultProvider;
    if (providerId === '') {
      // A bare model id with no named provider: identify it from the registry
      // and config pins, resolving the provider only when it is *known* (never
      // a guess). If it routes, use it; otherwise fall through to the explicit
      // error below.
      const rows = await unionRegistry({ configuredFor: configuredModelIds(config) });
      const identified = identifyModel(flags.model, { config, rows });
      if (identified.basis !== undefined) {
        return { providerId: identified.providerId, model: flags.model };
      }
      throw new UsageError(
        `“${flags.model}” does not name a provider and could not be identified. ` +
          'Use “provider/model”, or pass --provider.',
      );
    }
    return { providerId, model: flags.model };
  }

  const providerId = flags.provider ?? config.defaultProvider;
  if (providerId === '') {
    throw new UsageError(
      'No model selected. Pass --model “provider/model”, or set defaultProvider in config.',
    );
  }
  const configured = config.providers[providerId];
  if (configured === undefined) {
    throw new UsageError(
      `Provider “${providerId}” is not configured. Run “freecode providers add ${providerId}”.`,
    );
  }
  const first = configured.models[0] ?? config.defaultModel;
  if (first === '') {
    throw new UsageError(
      `No model known for provider “${providerId}”. Run “freecode models refresh”, ` +
        'or pass --model explicitly.',
    );
  }
  return { providerId, model: first };
}

/** Build the streaming request a provider's `stream()` expects. */
function toChatRequest(
  request: {
    readonly messages: readonly ChatMessage[];
    readonly tools: readonly AgentTool[];
    readonly signal: AbortSignal;
  },
  model: string,
  config: FreecodeConfig,
): ChatRequest {
  return {
    model,
    messages: request.messages,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    toolChoice: 'auto',
    stream: true,
    temperature: config.agent.temperature,
    timeoutMs: config.agent.requestTimeoutMs,
    signal: request.signal,
  };
}

/** Load ignore rules from the workspace `.gitignore`, plus the always-on set. */
async function loadIgnore(workspaceRoot: string): Promise<IgnoreMatcher | undefined> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const patterns = [...ALWAYS_IGNORED_PATTERNS];
  for (const name of ['.gitignore', '.freecodeignore']) {
    const contents = await readFile(path.join(workspaceRoot, name), 'utf8').catch(() => undefined);
    if (contents !== undefined) patterns.push(...contents.split('\n'));
  }
  return new IgnoreMatcher(patterns);
}

/** A short workspace description for the system prompt. */
async function workspaceSummary(
  cwd: string,
  guard: PathGuard,
  ignore: IgnoreMatcher | undefined,
  config: FreecodeConfig,
): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const limit = config.security.workspaceContextEntries;
  const entries: string[] = [];
  const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
    if (entries.length >= limit || depth > 2) return;
    const dirents = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (entries.length >= limit) return;
      const child = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
      if (ignore?.ignores(child, dirent.isDirectory()) === true) continue;
      entries.push(dirent.isDirectory() ? `${child}/` : child);
      if (dirent.isDirectory()) await walk(`${absolute}/${dirent.name}`, child, depth + 1);
    }
  };
  await walk(guard.workspaceRoot, '', 0);
  return [
    `You are working in the workspace at ${cwd}.`,
    'Its contents (a partial listing):',
    entries.join('\n'),
  ].join('\n');
}

function exitCodeFor(stopReason: string): number {
  switch (stopReason) {
    case 'end_turn':
    case 'tool_use':
      return ExitCode.Ok;
    case 'budget_iterations':
    case 'budget_tool_calls':
    case 'budget_tokens':
    case 'budget_time':
    case 'repeated_calls':
      return ExitCode.Quota;
    case 'aborted':
      return ExitCode.Interrupted;
    default:
      return ExitCode.Provider;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Approver
// ─────────────────────────────────────────────────────────────────────────────

interface ApproverOptions {
  readonly yes: boolean;
}

/**
 * An interactive approver.
 *
 * `--yes` short-circuits to allow-once with no prompt, and is declared
 * non-interactive so policy treats unattended approvals as intentional rather
 * than accidental. Without a TTY and without `--yes`, it is non-interactive and
 * refuses — a piped stdin must never be read as consent.
 */
export function makeApprover(options: ApproverOptions): Approver {
  const interactive = process.stdin.isTTY === true && options.yes === false;
  return {
    interactive,
    async request(input: ApprovalRequest) {
      if (options.yes) return 'allow-once';
      if (!interactive) return 'deny';
      return promptForApproval(input);
    },
  };
}

async function promptForApproval(
  input: ApprovalRequest,
): Promise<'allow-once' | 'allow-session' | 'deny'> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`\nApproval needed: ${input.reason}\n`);
    if (input.preview !== undefined) process.stderr.write(`${input.preview}\n`);
    process.stderr.write('Allow this action? [y]es / [a]lways / [n]o: ');
    const answer = await new Promise<string>((resolve) => rl.question('', resolve));
    const normalised = answer.trim().toLowerCase();
    if (normalised === 'a' || normalised === 'always') return 'allow-session';
    if (normalised === 'y' || normalised === 'yes') return 'allow-once';
    return 'deny';
  } finally {
    rl.close();
  }
}

/** Re-exported for testing the denial path without a terminal. */
export const nonInteractiveApprover: Approver = {
  interactive: false,
  request: async () => 'deny',
};
