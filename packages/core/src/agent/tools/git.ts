/**
 * Git tools and a patch applier.
 *
 * `git_status` and `git_diff` are read-only and shell out to `git` with an
 * argument array — never a shell string — so a filename the model supplies
 * cannot become a shell metacharacter. They are separate from `run_command`
 * because the common read-only git queries should not require the user to
 * approve a shell command each time.
 *
 * `apply_patch` applies a unified diff through `git apply`, which is far more
 * robust than hand-parsing a patch: it handles context matching and rejects a
 * patch that does not apply cleanly, rather than corrupting a file with a
 * partial application.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';

import { buildChildEnv } from '../../security/command-policy.js';
import { ok, fail, type ToolSpec } from './context.js';
import type { ToolResult } from '../types.js';

const MAX_GIT_BYTES = 200_000;

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `git` with an argument array in `cwd`. No shell is involved. */
async function git(cwd: string, argv: readonly string[]): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const child = spawn('git', argv, {
      cwd,
      env: buildChildEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const cap = (chunk: Buffer): string => {
      const text = chunk.toString('utf8');
      return text.length > MAX_GIT_BYTES ? text.slice(0, MAX_GIT_BYTES) : text;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_GIT_BYTES) stdout += cap(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_GIT_BYTES) stderr += cap(chunk);
    });
    child.on('error', () => resolve({ code: -1, stdout: '', stderr: 'git is not available' }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Whether the workspace is inside a git repository. */
async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.code === 0 && result.stdout.trim() === 'true';
}

export const gitStatusSpec: ToolSpec<z.ZodObject<{ path: z.ZodOptional<z.ZodString> }>> = {
  name: 'git_status',
  description: 'Show the working tree status as porcelain output. Read-only.',
  schema: z.object({
    path: z.string().optional().describe('Limit to this path, relative to the workspace.'),
  }),
  mutating: false,
  run: async (args, _invocation, ctx): Promise<ToolResult> => {
    if (!(await isGitRepo(ctx.guard.workspaceRoot))) {
      return fail('This workspace is not a git repository.');
    }
    let target = '.';
    if (args.path !== undefined) {
      const resolved = await ctx.guard.resolve(args.path, 'read');
      target = resolved.relative;
    }
    const result = await git(ctx.guard.workspaceRoot, ['status', '--porcelain', '--', target]);
    if (result.code !== 0) return fail(`git status failed: ${result.stderr.trim()}`);
    const output = result.stdout.trim();
    return ok(output === '' ? '(clean)' : output, {
      display: {
        kind: 'text',
        text: output === '' ? 'clean' : `${output.split('\n').length} change(s)`,
      },
    });
  },
};

export const gitDiffSpec: ToolSpec<
  z.ZodObject<{ path: z.ZodOptional<z.ZodString>; staged: z.ZodOptional<z.ZodBoolean> }>
> = {
  name: 'git_diff',
  description: 'Show unstaged (or staged) changes as a unified diff. Read-only.',
  schema: z.object({
    path: z.string().optional().describe('Limit the diff to this path.'),
    staged: z.boolean().optional().describe('Show staged changes instead of unstaged.'),
  }),
  mutating: false,
  run: async (args, _invocation, ctx): Promise<ToolResult> => {
    if (!(await isGitRepo(ctx.guard.workspaceRoot))) {
      return fail('This workspace is not a git repository.');
    }
    const argv = ['diff', '--no-color'];
    if (args.staged === true) argv.push('--cached');
    if (args.path !== undefined) {
      const resolved = await ctx.guard.resolve(args.path, 'read');
      argv.push('--', resolved.relative);
    }
    const result = await git(ctx.guard.workspaceRoot, argv);
    if (result.code !== 0) return fail(`git diff failed: ${result.stderr.trim()}`);
    const output = result.stdout.trim();
    return ok(output === '' ? '(no changes)' : output);
  },
};

export const applyPatchSpec: ToolSpec<
  z.ZodObject<{ patch: z.ZodString; path: z.ZodOptional<z.ZodString> }>
> = {
  name: 'apply_patch',
  description:
    'Apply a unified diff to the workspace with “git apply”. The patch must apply cleanly; a ' +
    'partial or conflicting patch is rejected rather than forced.',
  schema: z.object({
    patch: z.string().min(1).describe('A unified diff, as produced by “git diff”.'),
    path: z.string().optional().describe('Restrict the patch to this subtree.'),
  }),
  mutating: true,
  run: async (args, _invocation, ctx): Promise<ToolResult> => {
    if (!(await isGitRepo(ctx.guard.workspaceRoot))) {
      return fail('apply_patch requires a git repository.');
    }
    const argv = ['apply', '--whitespace=nowarn'];
    if (args.path !== undefined) {
      const resolved = await ctx.guard.resolve(args.path, 'write');
      argv.push('--directory', resolved.relative);
    }

    const result = await new Promise<GitResult>((resolve) => {
      const child = spawn('git', argv, {
        cwd: ctx.guard.workspaceRoot,
        env: buildChildEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', () => resolve({ code: -1, stdout: '', stderr: 'git is not available' }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(args.patch);
    });

    if (result.code !== 0) {
      return fail(`The patch did not apply: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return ok('Patch applied.', { changedPaths: extractPatchPaths(args.patch) });
  },
};

/**
 * Pull the target paths out of a unified diff's `+++`/`---` headers.
 *
 * Best-effort: used only for the change summary and checkpoint scope, never for
 * a security decision, so a header this misses is harmless.
 */
function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    const match =
      /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line) ?? /^--- (?:a\/)?(.+?)(?:\t.*)?$/.exec(line);
    if (match?.[1] !== undefined && match[1] !== '/dev/null') paths.add(match[1]);
  }
  return [...paths];
}

export const gitSpecs = [gitStatusSpec, gitDiffSpec, applyPatchSpec] as const;
