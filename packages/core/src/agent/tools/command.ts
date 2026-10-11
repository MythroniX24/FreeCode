/**
 * `run_command` — the one tool that executes arbitrary code.
 *
 * Because it is the most dangerous, it is the most constrained:
 *
 *  - **The command policy has the final say.** `assessCommand` classifies the
 *    line; a `deny` verdict is returned to the model as a refusal and nothing is
 *    executed. An `ask` verdict is surfaced to the approval layer, which prompts
 *    (or refuses, off a terminal).
 *
 *  - **The child gets a scrubbed environment.** `buildChildEnv` forwards only a
 *    build-safe allowlist; provider credentials and tokens are removed. A
 *    malicious `README` cannot exfiltrate a key that was never in the
 *    environment, and neither can a curious `env` at the prompt.
 *
 *  - **Output is bounded, and the bound is reported.** A command that prints a
 *    hundred megabytes must not be buffered into memory or into the model's
 *    context. Truncation is stated explicitly so the model knows it saw a
 *    partial result rather than silently reasoning from a fragment.
 *
 *  - **The working directory is the workspace root**, resolved through the
 *    guard when a subdirectory is requested, so a command cannot be run from a
 *    location the agent could not otherwise reach.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';

import { buildChildEnv } from '../../security/command-policy.js';
import { ok, fail, type ToolSpec } from './context.js';
import type { ToolResult } from '../types.js';

export const runCommandSpec: ToolSpec<
  z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    timeout_ms: z.ZodOptional<z.ZodNumber>;
  }>
> = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace and return its output. Use for builds, tests, and ' +
    'git. The environment is scrubbed of credentials. Output is truncated if very large.',
  schema: z.object({
    command: z.string().min(1).describe('The shell command line to run.'),
    cwd: z
      .string()
      .optional()
      .describe('Directory to run in, relative to the workspace. Defaults to the root.'),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .optional()
      .describe('Timeout in milliseconds. Defaults to the configured command timeout.'),
  }),
  mutating: true,
  executesCode: true,
  run: async (args, invocation, ctx): Promise<ToolResult> => {
    // Policy decides first. A denial never reaches a shell.
    const assessment = ctx.commandPolicy.assess(args.command);
    if (assessment.verdict === 'deny') {
      return fail(`Refused by policy: ${assessment.reason}`);
    }

    const cwdResolved = await ctx.guard.resolve(args.cwd ?? '.', 'execute');
    if (!cwdResolved.exists || !cwdResolved.isDirectory) {
      return fail(`Working directory not found: ${cwdResolved.relative}`);
    }

    const timeoutMs = args.timeout_ms ?? ctx.config.agent.commandTimeoutMs;
    const maxBytes = ctx.config.agent.maxCommandOutputBytes;

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(args.command, {
        cwd: cwdResolved.absolute,
        shell: true,
        env: buildChildEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let totalBytes = 0;
      let truncated = false;
      let settled = false;

      const capture = (chunk: Buffer, to: 'out' | 'err'): void => {
        totalBytes += chunk.byteLength;
        if (truncated) return;
        const text = chunk.toString('utf8');
        if (totalBytes > maxBytes) {
          truncated = true;
          const remaining = Math.max(0, maxBytes - (totalBytes - chunk.byteLength));
          const head = text.slice(0, remaining);
          if (to === 'out') stdout += head;
          else stderr += head;
          return;
        }
        if (to === 'out') stdout += text;
        else stderr += text;
      };

      child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'out'));
      child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'err'));

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve(
          fail(
            `Command timed out after ${timeoutMs}ms and was killed.\n${render(stdout, stderr, truncated)}`,
            { display: { kind: 'command', command: args.command, exitCode: 124 } },
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        clearTimeout(timer);
        resolve(fail(`Command interrupted.\n${render(stdout, stderr, truncated)}`));
      };
      if (invocation.signal.aborted) onAbort();
      else invocation.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        invocation.signal.removeEventListener('abort', onAbort);
        resolve(fail(`Failed to start the command: ${error.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        invocation.signal.removeEventListener('abort', onAbort);
        const exitCode = code ?? -1;
        const body = render(stdout, stderr, truncated);
        const result: ToolResult =
          exitCode === 0
            ? ok(body, { display: { kind: 'command', command: args.command, exitCode } })
            : fail(`Command exited with code ${exitCode}.\n${body}`, {
                display: { kind: 'command', command: args.command, exitCode },
              });
        resolve(result);
      });
    });
  },
};

/** Render captured output with stderr labelled and truncation noted. */
function render(stdout: string, stderr: string, truncated: boolean): string {
  const parts: string[] = [];
  if (stdout.trim() !== '') parts.push(stdout.trimEnd());
  if (stderr.trim() !== '') parts.push(`[stderr]\n${stderr.trimEnd()}`);
  if (truncated) parts.push('(output truncated)');
  return parts.length === 0 ? '(no output)' : parts.join('\n\n');
}
