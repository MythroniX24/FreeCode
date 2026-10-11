/**
 * Filesystem fixtures for tests.
 *
 * Temp directories are created under the *home* directory rather than
 * `os.tmpdir()`, because on Android/Termux `/tmp` is a `tmpfs` mounted with
 * restrictive permissions and shared-storage paths are FUSE mounts that do not
 * support symlinks — both of which the path-guard tests need. `$HOME` is a
 * normal filesystem on every platform this project targets.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];

/** Create a temp directory that `cleanupTempDirs` will remove. */
export async function makeTempDir(prefix = 'freecode-test-'): Promise<string> {
  const base = path.join(os.homedir(), '.freecode-test');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, prefix));
  created.push(dir);
  return dir;
}

/** Remove every directory created by `makeTempDir` in this process. */
export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    created
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
}

/** Build a file tree from a `{ 'relative/path': 'contents' }` map. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
}

/** Create a symlink, returning false when the platform/filesystem refuses. */
export async function trySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}
