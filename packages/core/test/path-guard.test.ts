/**
 * Path-guard tests — filesystem boundary enforcement.
 *
 * Every case here is a way an agent could be tricked into reading or writing
 * outside its workspace. These are the highest-value tests in the suite: a
 * regression here is a security incident, not a bug.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PathGuard } from '../src/security/path-guard.js';
import { IgnoreMatcher } from '../src/security/ignore.js';
import { PolicyDeniedError } from '../src/errors.js';
import { cleanupTempDirs, makeTempDir, trySymlink, writeTree } from './helpers/fs.js';

let workspace: string;
let outside: string;
let guard: PathGuard;

beforeAll(async () => {
  workspace = await makeTempDir('ws-');
  outside = await makeTempDir('outside-');

  await writeTree(workspace, {
    'src/index.ts': 'export const x = 1;\n',
    'src/nested/deep/file.ts': 'export const deep = true;\n',
    'README.md': '# project\n',
    '.env': 'API_KEY=sk-proj-AAAAAAAAAAA\n',
    '.env.example': 'API_KEY=\n',
    'keys/server.pem': '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n',
    'node_modules/pkg/index.js': 'module.exports = {};\n',
    'dist/bundle.js': 'bundled\n',
    '.npmrc': '//registry.npmjs.org/:_authToken=npm_SECRETVALUE\n',
  });

  await writeFile(path.join(outside, 'secret.txt'), 'outside the workspace\n');

  // A symlink *inside* the workspace pointing *outside* it. This is the classic
  // escape and must be refused even though the lexical path looks contained.
  await trySymlink(outside, path.join(workspace, 'escape-dir'));
  await trySymlink(path.join(outside, 'secret.txt'), path.join(workspace, 'escape-file.txt'));

  guard = await PathGuard.create({ workspaceRoot: workspace });
});

afterAll(async () => {
  await cleanupTempDirs();
});

/** Assert that `fn` rejects with a PolicyDeniedError carrying `reason`. */
async function expectDenied(fn: () => Promise<unknown>, reason?: string): Promise<void> {
  await expect(fn()).rejects.toBeInstanceOf(PolicyDeniedError);
  if (reason === undefined) return;
  const error = await fn().catch((e: unknown) => e);
  expect((error as PolicyDeniedError).details['denial']).toMatchObject({ reason });
}

describe('containment', () => {
  it('resolves a normal relative path inside the workspace', async () => {
    const resolved = await guard.resolve('src/index.ts');
    expect(resolved.relative).toBe('src/index.ts');
    expect(resolved.exists).toBe(true);
    expect(resolved.isFile).toBe(true);
  });

  it('resolves a nested path that does not exist yet', async () => {
    const resolved = await guard.resolve('src/brand/new.ts');
    expect(resolved.relative).toBe('src/brand/new.ts');
    expect(resolved.exists).toBe(false);
  });

  it('rejects a parent-traversal path', async () => {
    await expectDenied(() => guard.resolve('../../../etc/passwd'), 'outside-workspace');
  });

  it('rejects traversal hidden mid-path', async () => {
    await expectDenied(() => guard.resolve('src/../../../etc/passwd'), 'outside-workspace');
  });

  it('rejects an absolute path outside the workspace', async () => {
    await expectDenied(() => guard.resolve('/etc/passwd'), 'outside-workspace');
  });

  it('rejects a sibling directory that shares a name prefix', async () => {
    // The naive `${root}-evil`.startsWith(root) bug: a string-prefix check
    // would accept this, a segment-aware check must not.
    const evil = `${workspace}-evil`;
    await mkdir(evil, { recursive: true });
    await expectDenied(() => guard.resolve(`${evil}/x.txt`), 'outside-workspace');
  });

  it('rejects an empty path', async () => {
    await expectDenied(() => guard.resolve(''));
  });

  it('rejects a path containing a NUL byte', async () => {
    await expectDenied(() => guard.resolve('src/index.ts\0.png'), 'null-byte');
  });
});

describe('symlink escapes', () => {
  it('refuses to read through a symlinked directory that leaves the workspace', async () => {
    const created = await trySymlink(outside, path.join(workspace, 'escape-dir'));
    if (!created) return; // filesystem cannot symlink; covered by the realpath tests
    await expectDenied(() => guard.resolve('escape-dir/secret.txt'), 'outside-workspace');
  });

  it('refuses to read a symlinked file that leaves the workspace', async () => {
    const created = await trySymlink(
      path.join(outside, 'secret.txt'),
      path.join(workspace, 'escape-file.txt'),
    );
    if (!created) return;
    await expectDenied(() => guard.resolve('escape-file.txt'), 'outside-workspace');
  });

  it('refuses to write through a symlink even when the target is inside', async () => {
    // A symlink that *stays* inside is still refused for writes: following it
    // means the checked path and the written path differ, which is the TOCTOU
    // window this project will not accept.
    const target = path.join(workspace, 'src', 'index.ts');
    const link = path.join(workspace, 'src', 'link.ts');
    const created = await trySymlink(target, link);
    if (!created) return;
    await expectDenied(() => guard.assertWritable('src/link.ts'), 'outside-workspace');
  });
});

describe('sensitive files', () => {
  it('refuses to read a private key unconditionally', async () => {
    await expectDenied(() => guard.resolve('keys/server.pem', 'read'), 'sensitive-file');
  });

  it('refuses to read a package-manager auth file without approval', async () => {
    // `.npmrc` is classified overrideable, so a guard with sensitive reads
    // disabled refuses it; the tool layer is what offers an approval prompt.
    await expectDenied(() => guard.resolve('.npmrc', 'read'), 'sensitive-file');
  });

  it('refuses to write to .env', async () => {
    await expectDenied(() => guard.assertWritable('.env'), 'write-protected');
  });

  it('refuses to write to a private key', async () => {
    await expectDenied(() => guard.assertWritable('keys/server.pem'), 'write-protected');
  });

  it('permits reading .env.example (not a real environment file)', async () => {
    const resolved = await guard.resolve('.env.example', 'read');
    expect(resolved.exists).toBe(true);
  });

  it('permits sensitive reads when the policy explicitly allows them', async () => {
    const permissive = await PathGuard.create({
      workspaceRoot: workspace,
      allowSensitiveReads: true,
    });
    const resolved = await permissive.resolve('.env', 'read');
    expect(resolved.sensitivity?.category).toBe('environment');
  });

  it('returns the sensitivity record only for the explicit read-sensitive access', async () => {
    // `resolve(path, 'read')` refuses; `resolve(path, 'read-sensitive')` is the
    // opt-in the approval flow uses, and it reports the record instead.
    const resolved = await guard.resolve('.npmrc', 'read-sensitive');
    expect(resolved.sensitivity?.category).toBe('package-manager-auth');
    expect(resolved.sensitivity?.overrideable).toBe(true);
  });
});

describe('ignore rules', () => {
  it('excludes ignored paths during discovery (`list`)', async () => {
    const ignoring = await PathGuard.create({
      workspaceRoot: workspace,
      isIgnored: (relative, isDirectory) =>
        new IgnoreMatcher(['node_modules/', 'dist/']).ignores(relative, isDirectory),
    });
    await expectDenied(() => ignoring.resolve('node_modules/pkg/index.js', 'list'), 'ignored');
    await expectDenied(() => ignoring.resolve('dist/bundle.js', 'list'), 'ignored');
  });

  it('still permits an explicit read of an ignored file', async () => {
    // Ignore rules control what the agent *discovers*, not what it may open when
    // asked directly — otherwise checkpoint restoration of an ignored file fails.
    const ignoring = await PathGuard.create({
      workspaceRoot: workspace,
      isIgnored: (relative, isDirectory) =>
        new IgnoreMatcher(['dist/']).ignores(relative, isDirectory),
    });
    const resolved = await ignoring.resolve('dist/bundle.js', 'read');
    expect(resolved.exists).toBe(true);
  });

  it('allows writes into an ignored directory (build output is legitimate)', async () => {
    const ignoring = await PathGuard.create({
      workspaceRoot: workspace,
      isIgnored: (relative, isDirectory) =>
        new IgnoreMatcher(['dist/']).ignores(relative, isDirectory),
    });
    const resolved = await ignoring.assertWritable('dist/new-file.js');
    expect(resolved.relative).toBe('dist/new-file.js');
  });
});

describe('ensureDirectory', () => {
  it('creates a nested directory inside the workspace', async () => {
    const created = await guard.ensureDirectory('src/generated/deep');
    expect(created.startsWith(guard.workspaceRoot)).toBe(true);
  });

  it('refuses to create a directory outside the workspace', async () => {
    await expectDenied(() => guard.ensureDirectory('../escape'), 'outside-workspace');
  });
});

describe('canRead', () => {
  it('returns ok for a readable path', async () => {
    const result = await guard.canRead('README.md');
    expect(result.ok).toBe(true);
  });

  it('returns a denial instead of throwing', async () => {
    const result = await guard.canRead('keys/server.pem');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.reason).toBe('sensitive-file');
  });
});

describe('non-regular files', () => {
  it('refuses to write to a directory path as if it were a file', async () => {
    await expectDenied(() => guard.assertWritable('src'));
  });
});

describe('workspace identity', () => {
  it('reports the canonical workspace root', () => {
    expect(guard.workspaceRoot).toBeTruthy();
    expect(path.isAbsolute(guard.workspaceRoot)).toBe(true);
  });

  it('fails to create a guard for a non-existent root', async () => {
    await expect(
      PathGuard.create({ workspaceRoot: path.join(outside, 'does-not-exist-xyz') }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });
});

// Keep the imported symbol used so the intent (symlink helper is referenced) is
// clear even when the platform refuses symlinks and the branches are skipped.
void symlink;
