/**
 * The default toolset.
 *
 * `createTools` is the single place that decides what the agent can do. The
 * tools are assembled from specs bound to one `ToolContext`, so every tool
 * shares the same guard, command policy, and config — there is no way for one
 * tool to be built with a laxer policy than another.
 */

import type { z } from 'zod';

import type { AgentTool } from '../types.js';
import { bindSpecs, type ToolContext, type ToolSpec } from './context.js';
import { fileSpecs } from './files.js';
import { runCommandSpec } from './command.js';
import { gitSpecs } from './git.js';

export { bindSpec, bindSpecs, ok, fail, type ToolContext, type ToolSpec } from './context.js';
export {
  readFileSpec,
  writeFileSpec,
  editFileSpec,
  listFilesSpec,
  searchSpec,
  fileSpecs,
} from './files.js';
export { runCommandSpec } from './command.js';
export { gitStatusSpec, gitDiffSpec, applyPatchSpec, gitSpecs } from './git.js';

/** Every built-in tool spec, in the order they are presented to the model. */
export const ALL_TOOL_SPECS: readonly ToolSpec<z.ZodObject<z.ZodRawShape>>[] = [
  ...fileSpecs,
  ...gitSpecs,
  runCommandSpec,
];

/** The names of the built-in tools, for tests and documentation. */
export const TOOL_NAMES: readonly string[] = ALL_TOOL_SPECS.map((spec) => spec.name);

/** Build the default toolset bound to `ctx`. */
export function createTools(ctx: ToolContext): AgentTool[] {
  return bindSpecs(ALL_TOOL_SPECS, ctx);
}
