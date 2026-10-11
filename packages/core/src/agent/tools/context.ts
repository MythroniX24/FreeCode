/**
 * Tool infrastructure shared by every tool.
 *
 * A tool is a small, well-typed function over the workspace. This file supplies
 * the parts that would otherwise be copy-pasted into all of them:
 *
 *  - **Argument validation.** Each tool declares a `ToolSpec` with a zod schema;
 *    `bindSpec` derives both the JSON Schema handed to the model and the runtime
 *    check applied to its arguments. One source of truth means the schema the
 *    model is shown cannot drift from the schema it is held to.
 *
 *  - **A denial becomes a result.** A policy or usage error raised by the guard
 *    is caught and turned into a `ToolResult` with `isError`. The model is told
 *    *why* it was refused and can choose another path; the session does not end.
 *
 *  - **The context is bound once, at construction.** A spec's `run` receives the
 *    `ToolContext` directly, so no tool reaches for a global and no invocation
 *    carries hidden state.
 */

import { z } from 'zod';

import { PolicyDeniedError, UsageError, toFreecodeError } from '../../errors.js';
import type { PathGuard } from '../../security/path-guard.js';
import type { CommandPolicy } from '../../security/command-policy.js';
import type { IgnoreMatcher } from '../../security/ignore.js';
import type { ResolvedConfig } from '../../config/schema.js';
import type { Logger } from '../../util/logger.js';
import type { AgentTool, ToolInvocation, ToolResult } from '../types.js';

/** Everything a tool may reach. Injected, so a tool never imports the world. */
export interface ToolContext {
  /** Confines and resolves every path. */
  readonly guard: PathGuard;
  /** Classifies shell commands. */
  readonly commandPolicy: CommandPolicy;
  /** Whether listings and reads honour `.gitignore`. */
  readonly ignore: IgnoreMatcher | undefined;
  readonly config: ResolvedConfig;
  readonly logger: Logger;
}

/** Build a success result. */
export function ok(
  content: string,
  extra: Omit<ToolResult, 'content' | 'isError'> = {},
): ToolResult {
  return { content, isError: false, ...extra };
}

/** Build an error result — reported to the model, never thrown. */
export function fail(
  content: string,
  extra: Omit<ToolResult, 'content' | 'isError'> = {},
): ToolResult {
  return { content, isError: true, ...extra };
}

/** A tool's declaration, independent of any workspace. */
export interface ToolSpec<S extends z.ZodObject<z.ZodRawShape>> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly mutating: boolean;
  readonly executesCode?: boolean;
  readonly run: (
    args: z.infer<S>,
    invocation: ToolInvocation,
    ctx: ToolContext,
  ) => Promise<ToolResult>;
}

/** Field-level detail for a rejected argument set. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Bind a spec to a context, producing an `AgentTool` the loop can run.
 *
 * The JSON Schema is derived from the zod schema via zod's own converter, so a
 * tool cannot advertise one shape and validate against another.
 */
export function bindSpec<S extends z.ZodObject<z.ZodRawShape>>(
  spec: ToolSpec<S>,
  ctx: ToolContext,
): AgentTool {
  // `io: 'input'` keeps optional fields optional; `$schema` is stripped because
  // some providers reject it inside a tool's parameter object.
  const parameters = z.toJSONSchema(spec.schema, {
    io: 'input',
    target: 'draft-7',
  }) as Record<string, unknown>;
  delete parameters['$schema'];

  return {
    name: spec.name,
    description: spec.description,
    parameters,
    mutating: spec.mutating,
    executesCode: spec.executesCode ?? false,
    async run(invocation: ToolInvocation): Promise<ToolResult> {
      const parsed = spec.schema.safeParse(invocation.args);
      if (!parsed.success) {
        return fail(`Invalid arguments for “${spec.name}”: ${describeIssues(parsed.error)}.`);
      }
      try {
        return await spec.run(parsed.data, invocation, ctx);
      } catch (error) {
        // A policy denial or a usage error is the model's problem to solve, not
        // a crash: report it back and let the model react.
        if (error instanceof PolicyDeniedError || error instanceof UsageError) {
          return fail(error.message);
        }
        const freecode = toFreecodeError(error);
        ctx.logger.warn('tool threw', { tool: spec.name, error: freecode.message });
        return fail(`The tool “${spec.name}” failed: ${freecode.message}`);
      }
    },
  };
}

/** Bind a whole toolset to one context. */
export function bindSpecs(
  specs: readonly ToolSpec<z.ZodObject<z.ZodRawShape>>[],
  ctx: ToolContext,
): AgentTool[] {
  return specs.map((spec) => bindSpec(spec, ctx));
}
