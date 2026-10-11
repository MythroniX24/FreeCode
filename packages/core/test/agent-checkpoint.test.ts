/**
 * Checkpoints, against a real filesystem.
 *
 * The promise `freecode undo` makes is narrow and specific: the files an
 * operation touched are restored to exactly their prior state. "Exactly"
 * includes the cases that are easy to get wrong — a file that did not exist
 * must be absent again, and an executable bit must survive the round trip.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { FileCheckpointManager } from '../src/agent/checkpoint.js';
import { PolicyDeniedError } from '../src/errors.js';
import { nullLogger } from '../src/util/logger.js';
import { cleanupTempDirs, makeTempDir, writeTree } from './helpers/fs.js';

afterAll(async () => {
  await cleanupTempDirs();
});

/**
 * A manager whose checkpoint store lives in its own temp dir, so a test never
 * writes into the user's real data home and cannot collide with another test.
 */
async function manager(
  files: Record<string, string>,
  overrides: { maxCheckpoints?: number } = {},
): Promise<{ root: string; checkpoints: FileCheckpointManager }> {
  const root = await makeTempDir('freecode-ckpt-');
  await writeTree(root, files);
  const store = await makeTempDir('freecode-ckpt-store-');
  return {
    root,
    checkpoints: new FileCheckpointManager({
      workspaceRoot: root,
      maxCheckpoints: overrides.maxCheckpoints ?? 10,
      log: nullLogger(),
      baseDir: store,
    }),
  };
}

describe('FileCheckpointManager', () => {
  it('restores a modified file to its prior contents', async () => {
    const { root, checkpoints } = await manager({ 'src/a.ts': 'original\n' });
    const checkpoint = await checkpoints.create('before edit', ['src/a.ts']);
    expect(checkpoint).toBeDefined();

    await fs.writeFile(path.join(root, 'src/a.ts'), 'changed\n', 'utf8');
    await checkpoints.restore(checkpoint!.id);

    expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toBe('original\n');
  });

  it('deletes a file that did not exist when the checkpoint was taken', async () => {
    const { root, checkpoints } = await manager({});
    const checkpoint = await checkpoints.create('before create', ['new.txt']);

    // The tool creates the file afterwards; undo must remove it again.
    await fs.writeFile(path.join(root, 'new.txt'), 'created\n', 'utf8');
    await checkpoints.restore(checkpoint!.id);

    await expect(fs.stat(path.join(root, 'new.txt'))).rejects.toThrow();
  });

  it('preserves the executable bit across a restore', async () => {
    const { root, checkpoints } = await manager({ 'run.sh': '#!/bin/sh\n' });
    const target = path.join(root, 'run.sh');
    await fs.chmod(target, 0o755);

    const checkpoint = await checkpoints.create('before edit', ['run.sh']);
    await fs.chmod(target, 0o644);
    await checkpoints.restore(checkpoint!.id);

    const stats = await fs.stat(target);
    expect(stats.mode & 0o111).not.toBe(0);
  });

  it('returns undefined when there is nothing to snapshot', async () => {
    const { checkpoints } = await manager({});
    expect(await checkpoints.create('empty', [])).toBeUndefined();
  });

  it('refuses a path that escapes the workspace', async () => {
    const { checkpoints } = await manager({});
    await expect(checkpoints.create('escape', ['../outside.txt'])).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('refuses an id that could traverse the store', async () => {
    const { checkpoints } = await manager({ 'a.ts': 'x' });
    await expect(checkpoints.restore('../../etc/passwd')).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('reports a clear error for an unknown checkpoint', async () => {
    const { checkpoints } = await manager({});
    await expect(checkpoints.restore('nope-not-here')).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('lists checkpoints newest first and exposes the latest', async () => {
    const { checkpoints } = await manager({ 'a.ts': 'x', 'b.ts': 'y' });
    const first = await checkpoints.create('first', ['a.ts']);
    const second = await checkpoints.create('second', ['b.ts']);

    const list = await checkpoints.list();
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(second!.id);
    expect((await checkpoints.latest())!.id).toBe(second!.id);
    expect(list.map((c) => c.id)).toContain(first!.id);
  });

  it('prunes the oldest checkpoints beyond the limit', async () => {
    const { checkpoints } = await manager({ 'a.ts': 'x' }, { maxCheckpoints: 2 });
    await checkpoints.create('one', ['a.ts']);
    await checkpoints.create('two', ['a.ts']);
    await checkpoints.create('three', ['a.ts']);

    const list = await checkpoints.list();
    expect(list.length).toBe(2);
    expect(list.map((c) => c.label)).toEqual(['three', 'two']);
  });
});
