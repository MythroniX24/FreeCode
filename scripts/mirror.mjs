#!/usr/bin/env node
/**
 * mirror.mjs — build-mirror helper for Android/Termux.
 *
 * WHY THIS EXISTS
 * ---------------
 * The authoritative source tree for FreeCode may live on Android shared storage
 * (`/storage/emulated/0/...`), which is mounted through a FUSE layer that does not
 * support `symlink(2)`. npm needs symlinks for two things it cannot avoid:
 *   1. `node_modules/.bin/*` shims (tsc, vitest, eslint, prettier)
 *   2. workspace links (`node_modules/@freecode/core` -> `packages/core`)
 * With symlinks unavailable, `npm install` fails with EACCES on this filesystem.
 *
 * Rather than degrade the deliverable's location, we keep the source of truth
 * where the user wants it and perform installs/builds/tests in a *mirror* that
 * lives on symlink-capable storage (typically `$HOME`, an f2fs/ext4 volume).
 *
 * The source of truth is always the project directory. The mirror is disposable:
 * `mirror push` copies source in, `mirror pull` copies build outputs back out.
 *
 * USAGE
 *   node scripts/mirror.mjs push      # project -> mirror (source files only)
 *   node scripts/mirror.mjs pull      # mirror -> project (dist/, coverage/, lockfile)
 *   node scripts/mirror.mjs run <cmd> # push, run npm command in mirror, then pull
 *   node scripts/mirror.mjs path      # print mirror path
 *   node scripts/mirror.mjs clean     # delete the mirror
 *
 * On filesystems that support symlinks this script is unnecessary; plain
 * `npm install && npm test` in the project works there. It is a no-op guard,
 * not a replacement, for normal development.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PROJECT_DIR = path.resolve(import.meta.dirname, '..');

/** Directories copied between project and mirror (source of truth -> mirror). */
const SOURCE_ENTRIES = [
  'package.json',
  'package-lock.json',
  '.npmrc',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.check.json',
  'vitest.config.ts',
  'vitest.gateway.config.ts',
  'eslint.config.js',
  '.prettierrc.json',
  '.prettierignore',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'docs',
  'scripts',
  'packages',
  'examples',
];

/**
 * Entries copied back from mirror to project after a build (generated
 * artifacts), relative to the repository root *and* to each workspace package.
 * The build emits `dist/` per package (`packages/<name>/dist`), so pulling only
 * the root would return nothing in this monorepo.
 */
const ARTIFACT_ENTRIES = ['dist', 'coverage'];

/** Package directories whose artifacts are pulled back. */
const PACKAGE_DIRS = ['packages'];

/** Never copied in either direction when walking source. */
const EXCLUDED_BASENAMES = new Set([
  'node_modules',
  '.git',
  '.freecode',
  'coverage',
  'dist',
  '*.tsbuildinfo',
]);

/** Never copied back from a build artifact tree. */
const ARTIFACT_EXCLUDED_BASENAMES = new Set(['node_modules', '.git', '.freecode']);

function mirrorRoot() {
  if (process.env.FREECODE_MIRROR_DIR) return path.resolve(process.env.FREECODE_MIRROR_DIR);
  const base = os.homedir();
  const tag = createHash('sha256').update(PROJECT_DIR).digest('hex').slice(0, 12);
  return path.join(base, '.freecode-mirror', tag);
}

function skip(name) {
  if (EXCLUDED_BASENAMES.has(name)) return true;
  if (name.endsWith('.tsbuildinfo')) return true;
  if (name === '.env' || name.startsWith('.env.')) return true;
  return false;
}

function skipArtifact(name) {
  if (ARTIFACT_EXCLUDED_BASENAMES.has(name)) return true;
  if (name.endsWith('.tsbuildinfo')) return true;
  return false;
}

/**
 * @param {(name: string) => boolean} skipEntry predicate deciding what to omit
 */
async function copyTree(from, to, skipEntry) {
  const st = await stat(from).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { force: true });
    return;
  }
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (skipEntry(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dst, skipEntry);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await mkdir(path.dirname(dst), { recursive: true });
      await cp(src, dst, { force: true, dereference: false }).catch(async () => {
        // Fall back to a content copy when dereferencing a symlink fails.
        if (entry.isSymbolicLink()) return;
        throw new Error(`failed to copy ${src}`);
      });
    }
  }
}

async function push() {
  const root = mirrorRoot();
  await mkdir(root, { recursive: true });
  for (const name of SOURCE_ENTRIES) {
    const src = path.join(PROJECT_DIR, name);
    if (!existsSync(src)) continue;
    await copyTree(src, path.join(root, name), skip);
  }
  // Keep the package name stable for npm so workspace resolution is deterministic.
  await writeFile(
    path.join(root, '.freecode-mirror.json'),
    JSON.stringify({ project: PROJECT_DIR }, null, 2),
  );
  console.log(`[mirror] pushed ${PROJECT_DIR} -> ${root}`);
  return root;
}

/** Copy one artifact entry (e.g. `dist`) from a mirror dir back to the project. */
async function pullEntry(root, dest, name) {
  const src = path.join(root, name);
  if (!existsSync(src)) return;
  const dst = path.join(dest, name);
  await rm(dst, { recursive: true, force: true });
  await copyTree(src, dst, skipArtifact);
}

async function pull() {
  const root = mirrorRoot();
  // Root-level artifacts (e.g. a coverage report written at the repo root).
  for (const name of ARTIFACT_ENTRIES) {
    await pullEntry(root, PROJECT_DIR, name);
  }
  // Per-package artifacts: the build emits `packages/<name>/dist`.
  for (const packagesDir of PACKAGE_DIRS) {
    const packagesRoot = path.join(root, packagesDir);
    if (!existsSync(packagesRoot)) continue;
    const names = await readdir(packagesRoot).catch(() => []);
    for (const name of names) {
      const mirrorPkg = path.join(packagesRoot, name);
      const projectPkg = path.join(PROJECT_DIR, packagesDir, name);
      for (const artifact of ARTIFACT_ENTRIES) {
        await pullEntry(mirrorPkg, projectPkg, artifact);
      }
    }
  }
  // The lockfile and its node_modules bookkeeping live only at the root.
  for (const name of ['package-lock.json', 'node_modules/.package-lock.json']) {
    const src = path.join(root, name);
    if (!existsSync(src)) continue;
    const dst = path.join(PROJECT_DIR, name);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst, { force: true });
  }
  console.log(`[mirror] pulled build artifacts -> ${PROJECT_DIR}`);
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'path':
      console.log(mirrorRoot());
      return 0;
    case 'push':
      await push();
      return 0;
    case 'pull':
      await pull();
      return 0;
    case 'clean':
      await rm(mirrorRoot(), { recursive: true, force: true });
      console.log('[mirror] cleaned');
      return 0;
    case 'run': {
      const root = await push();
      const [cmd, ...cmdArgs] = rest;
      if (!cmd) throw new Error('usage: mirror.mjs run <command> [args...]');
      const code = await run(cmd, cmdArgs, root);
      await pull();
      return code;
    }
    default:
      console.error('usage: mirror.mjs <push|pull|run|path|clean>');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[mirror] ${err?.message ?? err}`);
    process.exit(1);
  },
);
