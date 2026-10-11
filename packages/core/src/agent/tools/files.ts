/**
 * File tools: read, write, edit, list, search.
 *
 * Every path goes through `PathGuard`, which is what actually enforces
 * containment, symlink safety, sensitivity, and write protection. These tools
 * do not re-implement any of that; they call the guard and let a denial surface
 * as a tool error. That the tools are thin here is the point — one place decides
 * what a path may do, so a tool cannot accidentally be more permissive.
 *
 * A note on `edit_file`: it does an exact-substring replacement, not a
 * fuzzy match. The model must supply the precise text it wants replaced
 * (and enough surrounding context to be unambiguous). Fuzzy matching is what
 * makes edit tools corrupt files: a "close enough" match silently rewrites the
 * wrong region. An exact match that fails is a clear, recoverable error.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { diffLines, diffStats, formatDiff } from '../../util/diff.js';
import { ok, fail, type ToolSpec } from './context.js';
import type { ToolResult } from '../types.js';

const RELATIVE_PATH = z
  .string()
  .min(1)
  .describe('Path relative to the workspace root. Absolute paths and “..” are refused.');

/** Read a file into the model's context, bounded and ignore-aware. */
export const readFileSpec: ToolSpec<
  z.ZodObject<{
    path: z.ZodString;
    offset: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodOptional<z.ZodNumber>;
  }>
> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Returns the content with line numbers. ' +
    'Use offset and limit to read a slice of a large file.',
  schema: z.object({
    path: RELATIVE_PATH,
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-based line to start from. Defaults to the first line.'),
    limit: z.number().int().min(1).optional().describe('Maximum number of lines to return.'),
  }),
  mutating: false,
  run: async (args, _invocation, ctx): Promise<ToolResult> => {
    const resolved = await ctx.guard.resolve(args.path, 'read');
    if (!resolved.exists) return fail(`No such file: ${resolved.relative}`);
    if (resolved.isDirectory) {
      return fail(`${resolved.relative} is a directory; use list_files instead.`);
    }
    if (ctx.ignore?.ignores(resolved.relative) === true) {
      return fail(`${resolved.relative} is excluded by the project ignore rules.`);
    }

    const maxBytes = ctx.config.agent.maxFileReadBytes;
    const buffer = await fs.readFile(resolved.absolute);
    const truncatedBytes = buffer.byteLength > maxBytes;
    const body = buffer.subarray(0, maxBytes).toString('utf8');

    const allLines = body.split('\n');
    const start = (args.offset ?? 1) - 1;
    const end = args.limit === undefined ? allLines.length : start + args.limit;
    const slice = allLines.slice(start, end);

    if (slice.length === 0) {
      return ok(`(no lines in range; the file has ${allLines.length} lines)`, {
        bytes: buffer.byteLength,
      });
    }

    const numbered = slice
      .map((line, index) => `${String(start + index + 1).padStart(5)}│ ${line}`)
      .join('\n');
    const notes: string[] = [];
    if (truncatedBytes) notes.push(`truncated at ${maxBytes} bytes`);
    if (end < allLines.length) notes.push(`showing lines ${start + 1}–${start + slice.length}`);
    const suffix = notes.length === 0 ? '' : `\n\n(${notes.join('; ')})`;
    return ok(`${numbered}${suffix}`, { bytes: buffer.byteLength });
  },
};

/** Create or overwrite a file with full content. */
export const writeFileSpec: ToolSpec<z.ZodObject<{ path: z.ZodString; content: z.ZodString }>> = {
  name: 'write_file',
  description:
    'Write a file, creating it or replacing its entire contents. Provide the complete new ' +
    'content. For a targeted change to an existing file, prefer edit_file.',
  schema: z.object({
    path: RELATIVE_PATH,
    content: z.string().describe('The complete file contents to write.'),
  }),
  mutating: true,
  run: async (args, _invocation, ctx): Promise<ToolResult> => {
    const resolved = await ctx.guard.resolve(args.path, 'write');
    const before = resolved.exists ? await fs.readFile(resolved.absolute, 'utf8') : '';
    const after = args.content;

    await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
    await fs.writeFile(resolved.absolute, after, { encoding: 'utf8', mode: 0o644 });

    const lines = diffLines(before, after);
    const stats = diffStats(lines);
    const verb = resolved.exists ? 'Updated' : 'Created';
    return ok(`${verb} ${resolved.relative} (+${stats.added} −${stats.removed}).`, {
      changedPaths: [resolved.relative],
      display: {
        kind: 'diff',
        path: resolved.relative,
        diff: formatDiff(resolved.relative, lines),
      },
    });
  },
};

/** Replace an exact substring within a file. */
export const editFileSpec: ToolSpec<
  z.ZodObject<{
    path: z.ZodString;
    old_string: z.ZodString;
    new_string: z.ZodString;
    replace_all: z.ZodOptional<z.ZodBoolean>;
  }>
> = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must appear verbatim in the file and must ' +
    'be unique unless replace_all is true. Include enough surrounding context to make it unique.',
  schema: z.object({
    path: RELATIVE_PATH,
    old_string: z.string().min(1).describe('The exact text to replace, as it appears in the file.'),
    new_string: z.string().describe('The replacement text.'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace every occurrence instead of requiring uniqueness.'),
  }),
  mutating: true,
  run: async (args, _invocation, ctx): Promise<ToolResult> => {
    const resolved = await ctx.guard.resolve(args.path, 'write');
    if (!resolved.exists)
      return fail(`No such file: ${resolved.relative}. Use write_file to create it.`);

    const before = await fs.readFile(resolved.absolute, 'utf8');
    const occurrences = countOccurrences(before, args.old_string);
    if (occurrences === 0) {
      return fail(
        `old_string was not found in ${resolved.relative}. It must match the file exactly, ` +
          'including whitespace and indentation.',
      );
    }
    if (occurrences > 1 && args.replace_all !== true) {
      return fail(
        `old_string appears ${occurrences} times in ${resolved.relative}; it must be unique, ` +
          'or set replace_all to true.',
      );
    }

    const after =
      args.replace_all === true
        ? before.split(args.old_string).join(args.new_string)
        : before.replace(args.old_string, args.new_string);

    await fs.writeFile(resolved.absolute, after, { encoding: 'utf8', mode: 0o644 });

    const lines = diffLines(before, after);
    const stats = diffStats(lines);
    return ok(
      `Edited ${resolved.relative} (${occurrences} replacement${occurrences === 1 ? '' : 's'}, ` +
        `+${stats.added} −${stats.removed}).`,
      {
        changedPaths: [resolved.relative],
        display: {
          kind: 'diff',
          path: resolved.relative,
          diff: formatDiff(resolved.relative, lines),
        },
      },
    );
  },
};

/** List directory entries, honouring ignore rules. */
export const listFilesSpec: ToolSpec<
  z.ZodObject<{ path: z.ZodOptional<z.ZodString>; recursive: z.ZodOptional<z.ZodBoolean> }>
> = {
  name: 'list_files',
  description:
    'List files in the workspace. Directories are marked with a trailing slash. Set recursive ' +
    'to walk subdirectories; ignore rules are applied either way.',
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe('Directory to list, relative to the workspace. Defaults to the root.'),
    recursive: z.boolean().optional().describe('Walk subdirectories. Default false.'),
  }),
  mutating: false,
  run: async (args, _invocation, ctx): Promise<ToolResult> => {
    const resolved = await ctx.guard.resolve(args.path ?? '.', 'list');
    if (!resolved.exists) return fail(`No such directory: ${resolved.relative}`);
    if (!resolved.isDirectory) return fail(`${resolved.relative} is not a directory.`);

    const max = ctx.config.agent.maxListEntries;
    const entries: string[] = [];
    let truncated = false;

    const walk = async (absolute: string, relative: string): Promise<void> => {
      if (entries.length >= max) {
        truncated = true;
        return;
      }
      const dirents = await fs.readdir(absolute, { withFileTypes: true });
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const dirent of dirents) {
        if (entries.length >= max) {
          truncated = true;
          return;
        }
        const childRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
        const isDir = dirent.isDirectory();
        if (ctx.ignore?.ignores(childRelative, isDir) === true) continue;
        entries.push(isDir ? `${childRelative}/` : childRelative);
        if (isDir && args.recursive === true) {
          await walk(path.join(absolute, dirent.name), childRelative);
        }
      }
    };

    await walk(resolved.absolute, resolved.relative === '.' ? '' : resolved.relative);
    if (entries.length === 0) return ok('(empty)', { display: { kind: 'paths', paths: [] } });

    const suffix = truncated ? `\n\n(truncated at ${max} entries)` : '';
    return ok(`${entries.join('\n')}${suffix}`, { display: { kind: 'paths', paths: entries } });
  },
};

/** Search file contents for a regular expression. */
export const searchSpec: ToolSpec<
  z.ZodObject<{
    pattern: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
    glob: z.ZodOptional<z.ZodString>;
    max_results: z.ZodOptional<z.ZodNumber>;
  }>
> = {
  name: 'search',
  description:
    'Search file contents with a JavaScript regular expression. Returns path:line: text matches. ' +
    'Optionally restrict to a subtree and files matching a simple glob (*.ts).',
  schema: z.object({
    pattern: z.string().min(1).describe('A JavaScript regular expression.'),
    path: z
      .string()
      .optional()
      .describe('Subtree to search, relative to the workspace. Defaults to the root.'),
    glob: z
      .string()
      .optional()
      .describe('Only search files whose path ends with this suffix, e.g. “.ts”.'),
    max_results: z.number().int().min(1).optional().describe('Stop after this many matches.'),
  }),
  mutating: false,
  run: async (args, _invocation, ctx): Promise<ToolResult> => {
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, 'g');
    } catch (error) {
      return fail(`Invalid regular expression: ${(error as Error).message}`);
    }

    const resolved = await ctx.guard.resolve(args.path ?? '.', 'read');
    if (!resolved.exists) return fail(`No such path: ${resolved.relative}`);

    const max = args.max_results ?? 200;
    const matches: string[] = [];
    const maxFileBytes = ctx.config.agent.maxFileReadBytes;

    const searchFile = async (absolute: string, relative: string): Promise<void> => {
      if (args.glob !== undefined && !relative.endsWith(args.glob)) return;
      const stats = await fs.stat(absolute).catch(() => undefined);
      if (stats === undefined || stats.size > maxFileBytes) return;
      const content = await fs.readFile(absolute, 'utf8').catch(() => undefined);
      if (content === undefined || content.includes('\0')) return; // skip binary
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          matches.push(`${relative}:${index + 1}: ${line.trim().slice(0, 200)}`);
          if (matches.length >= max) return;
        }
      }
    };

    const walk = async (absolute: string, relative: string): Promise<void> => {
      if (matches.length >= max) return;
      if (resolved.isFile) {
        await searchFile(absolute, relative);
        return;
      }
      const dirents = await fs.readdir(absolute, { withFileTypes: true });
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const dirent of dirents) {
        if (matches.length >= max) return;
        const childRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`;
        const isDir = dirent.isDirectory();
        if (ctx.ignore?.ignores(childRelative, isDir) === true) continue;
        const childAbsolute = path.join(absolute, dirent.name);
        if (isDir) await walk(childAbsolute, childRelative);
        else await searchFile(childAbsolute, childRelative);
      }
    };

    await walk(resolved.absolute, resolved.relative === '.' ? '' : resolved.relative);
    if (matches.length === 0) return ok(`No matches for /${args.pattern}/.`);
    const suffix = matches.length >= max ? `\n\n(stopped at ${max} matches)` : '';
    return ok(`${matches.join('\n')}${suffix}`, {
      display: { kind: 'text', text: `${matches.length} match(es)` },
    });
  },
};

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const fileSpecs = [
  readFileSpec,
  writeFileSpec,
  editFileSpec,
  listFilesSpec,
  searchSpec,
] as const;
