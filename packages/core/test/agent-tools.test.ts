/**
 * The tool suite, exercised against a real temp workspace.
 *
 * These tests use a genuine `PathGuard` over a real directory rather than a
 * stub, because the guard *is* the security boundary: a test that mocked it
 * would assert that a tool calls the mock, not that it cannot escape the
 * workspace. The assertions are therefore about observable behaviour — a write
 * outside the root is refused, a sensitive file needs approval, a command the
 * policy denies never spawns a process.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CommandPolicy, IgnoreMatcher, PathGuard, ALWAYS_IGNORED_PATTERNS } from '../src/index.js';
import { createTools } from '../src/agent/tools/index.js';
import type { ToolContext } from '../src/agent/tools/context.js';
import type { AgentTool } from '../src/agent/types.js';
import { withDefaults } from '../src/config/schema.js';
import { nullLogger } from '../src/util/logger.js';
import { cleanupTempDirs, makeTempDir, writeTree } from './helpers/fs.js';

afterAll(async () => {
  await cleanupTempDirs();
});

async function workspace(files: Record<string, string> = {}): Promise<ToolContext> {
  const root = await makeTempDir('freecode-tool-');
  await writeTree(root, files);
  const guard = await PathGuard.create({ workspaceRoot: root });
  const config = withDefaults({});
  return {
    guard,
    commandPolicy: new CommandPolicy({ autoApproveReadOnly: true }),
    ignore: new IgnoreMatcher([...ALWAYS_IGNORED_PATTERNS, 'node_modules/', '*.log']),
    config,
    logger: nullLogger(),
  };
}

function find(tools: readonly AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

async function call(tool: AgentTool, args: Record<string, unknown>) {
  const controller = new AbortController();
  return tool.run({
    call: { id: 'x', name: tool.name, argumentsJson: JSON.stringify(args) },
    args,
    signal: controller.signal,
  });
}

describe('read_file', () => {
  it('reads a file with line numbers', async () => {
    const ctx = await workspace({ 'src/a.ts': 'line one\nline two\n' });
    const result = await call(find(createTools(ctx), 'read_file'), { path: 'src/a.ts' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('line one');
    expect(result.content).toContain('1│');
  });

  it('refuses a path that escapes the workspace', async () => {
    const ctx = await workspace({ 'a.ts': 'x' });
    const result = await call(find(createTools(ctx), 'read_file'), { path: '../../etc/passwd' });
    expect(result.isError).toBe(true);
  });

  it('reports a missing file as an error result, not a throw', async () => {
    const ctx = await workspace();
    const result = await call(find(createTools(ctx), 'read_file'), { path: 'nope.ts' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No such file');
  });

  it('skips files excluded by the ignore rules', async () => {
    const ctx = await workspace({ 'debug.log': 'noise' });
    const result = await call(find(createTools(ctx), 'read_file'), { path: 'debug.log' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ignore');
  });

  it('refuses a sensitive file (.env) without approval', async () => {
    const ctx = await workspace({ '.env': 'SECRET=1' });
    const result = await call(find(createTools(ctx), 'read_file'), { path: '.env' });
    expect(result.isError).toBe(true);
  });
});

describe('write_file', () => {
  it('creates a file and reports a diff', async () => {
    const ctx = await workspace();
    const result = await call(find(createTools(ctx), 'write_file'), {
      path: 'new.txt',
      content: 'hello\n',
    });
    expect(result.isError).toBe(false);
    expect(result.changedPaths).toContain('new.txt');
    expect(result.display?.kind).toBe('diff');
    expect(await fs.readFile(path.join(ctx.guard.workspaceRoot, 'new.txt'), 'utf8')).toBe(
      'hello\n',
    );
  });

  it('refuses to write outside the workspace', async () => {
    const ctx = await workspace();
    const result = await call(find(createTools(ctx), 'write_file'), {
      path: '../escape.txt',
      content: 'x',
    });
    expect(result.isError).toBe(true);
  });

  it('refuses to overwrite a write-protected file (.env)', async () => {
    const ctx = await workspace({ '.env': 'A=1' });
    const result = await call(find(createTools(ctx), 'write_file'), {
      path: '.env',
      content: 'B=2',
    });
    expect(result.isError).toBe(true);
  });
});

describe('edit_file', () => {
  it('replaces a unique substring', async () => {
    const ctx = await workspace({ 'a.ts': 'const x = 1;\nconst y = 2;\n' });
    const result = await call(find(createTools(ctx), 'edit_file'), {
      path: 'a.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 42;',
    });
    expect(result.isError).toBe(false);
    expect(await fs.readFile(path.join(ctx.guard.workspaceRoot, 'a.ts'), 'utf8')).toContain(
      'const x = 42;',
    );
  });

  it('refuses a non-unique match unless replace_all is set', async () => {
    const ctx = await workspace({ 'a.ts': 'x\nx\n' });
    const tools = createTools(ctx);
    const ambiguous = await call(find(tools, 'edit_file'), {
      path: 'a.ts',
      old_string: 'x',
      new_string: 'y',
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toContain('2 times');

    const all = await call(find(tools, 'edit_file'), {
      path: 'a.ts',
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    });
    expect(all.isError).toBe(false);
    expect(await fs.readFile(path.join(ctx.guard.workspaceRoot, 'a.ts'), 'utf8')).toBe('y\ny\n');
  });

  it('reports a missing old_string clearly', async () => {
    const ctx = await workspace({ 'a.ts': 'hello\n' });
    const result = await call(find(createTools(ctx), 'edit_file'), {
      path: 'a.ts',
      old_string: 'goodbye',
      new_string: 'hi',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });
});

describe('list_files', () => {
  it('lists entries and marks directories', async () => {
    const ctx = await workspace({ 'src/a.ts': 'x', 'top.txt': 'y' });
    const result = await call(find(createTools(ctx), 'list_files'), { path: '.' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('src/');
    expect(result.content).toContain('top.txt');
  });

  it('walks recursively and applies ignore rules', async () => {
    const ctx = await workspace({ 'src/a.ts': 'x', 'node_modules/pkg/index.js': 'y' });
    const result = await call(find(createTools(ctx), 'list_files'), {
      path: '.',
      recursive: true,
    });
    expect(result.content).toContain('src/a.ts');
    expect(result.content).not.toContain('node_modules');
  });
});

describe('search', () => {
  it('finds matches with path and line number', async () => {
    const ctx = await workspace({ 'a.ts': 'const needle = 1;\n', 'b.ts': 'nothing\n' });
    const result = await call(find(createTools(ctx), 'search'), { pattern: 'needle' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('a.ts:1:');
  });

  it('rejects an invalid regular expression without throwing', async () => {
    const ctx = await workspace();
    const result = await call(find(createTools(ctx), 'search'), { pattern: '([' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid regular expression');
  });
});

describe('run_command', () => {
  it('runs a benign command and returns its output', async () => {
    const ctx = await workspace({ 'a.txt': 'hello\n' });
    const result = await call(find(createTools(ctx), 'run_command'), { command: 'cat a.txt' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
  });

  it('reports a non-zero exit as an error result', async () => {
    const ctx = await workspace();
    const result = await call(find(createTools(ctx), 'run_command'), { command: 'exit 3' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('code 3');
  });

  it('does not leak provider credentials into the child environment', async () => {
    const ctx = await workspace();
    process.env['GROQ_API_KEY'] = 'sk-should-not-leak';
    try {
      const result = await call(find(createTools(ctx), 'run_command'), {
        command: 'echo "key=[$GROQ_API_KEY]"',
      });
      expect(result.content).not.toContain('sk-should-not-leak');
      expect(result.content).toContain('key=[]');
    } finally {
      delete process.env['GROQ_API_KEY'];
    }
  });

  it('never spawns a command the policy denies', async () => {
    const root = await makeTempDir('freecode-tool-');
    const guard = await PathGuard.create({ workspaceRoot: root });
    const ctx: ToolContext = {
      guard,
      commandPolicy: new CommandPolicy({ deniedCommands: ['rm'] }),
      ignore: undefined,
      config: withDefaults({}),
      logger: nullLogger(),
    };
    const result = await call(find(createTools(ctx), 'run_command'), { command: 'rm -rf /' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refused by policy');
  });
});
