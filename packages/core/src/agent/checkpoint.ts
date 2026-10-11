/**
 * Workspace checkpoints.
 *
 * A checkpoint is a copy of the files an operation is about to touch, taken
 * *before* it runs, so `freecode undo` can restore them. Two design choices
 * worth stating:
 *
 *  - **Snapshot the touched paths, not the repository.** An agent edit is
 *    usually one or two files, so copying those files is cheap and needs no
 *    git. A whole-tree snapshot would be slow on a real repository and would
 *    also capture unrelated local changes, which `undo` must not silently
 *    revert.
 *
 *  - **A missing file is part of the snapshot.** Creating a file is a change;
 *    undoing it means deleting the file. The snapshot records "did not exist"
 *    explicitly so restore can reproduce absence as faithfully as content.
 *
 * The store lives under the data home, keyed by a hash of the workspace root,
 * so checkpoints for different projects never collide and a checkpoint is never
 * written into the repository it describes.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { checkpointsDir } from '../config/paths.js';
import { PolicyDeniedError } from '../errors.js';
import type { Logger } from '../util/logger.js';
import type { Checkpoint, CheckpointManager } from './types.js';

/** One file's saved state within a checkpoint. */
interface SavedFile {
  /** Workspace-relative POSIX path. */
  readonly path: string;
  /** `true` when the file did not exist at snapshot time. */
  readonly absent: boolean;
  /** Base64 of the file's bytes. Present only when `absent` is false. */
  readonly dataBase64?: string;
  /** File mode, so an executable bit survives a restore. */
  readonly mode?: number;
}

interface CheckpointFile {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly workspace: string;
  readonly files: readonly SavedFile[];
}

/** A filesystem-backed `CheckpointManager`. */
export class FileCheckpointManager implements CheckpointManager {
  readonly #workspaceRoot: string;
  readonly #baseDir: string;
  readonly #maxCheckpoints: number;
  readonly #log: Logger;

  constructor(options: {
    readonly workspaceRoot: string;
    readonly maxCheckpoints: number;
    readonly log: Logger;
    /** Override the checkout store location (tests). */
    readonly baseDir?: string;
  }) {
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    const tag = createHash('sha256').update(this.#workspaceRoot).digest('hex').slice(0, 16);
    this.#baseDir = path.join(options.baseDir ?? checkpointsDir(), tag);
    this.#maxCheckpoints = Math.max(1, options.maxCheckpoints);
    this.#log = options.log;
  }

  async create(label: string, paths: readonly string[]): Promise<Checkpoint | undefined> {
    const unique = [...new Set(paths)].sort();
    if (unique.length === 0) return undefined;

    const files: SavedFile[] = [];
    for (const relative of unique) {
      const absolute = path.resolve(this.#workspaceRoot, relative);
      this.#assertInside(absolute, relative);
      const stats = await stat(absolute).catch(() => undefined);
      if (stats === undefined) {
        files.push({ path: toPosix(path.relative(this.#workspaceRoot, absolute)), absent: true });
        continue;
      }
      if (!stats.isFile()) continue; // Directories are recreated impliedly by their files.
      const bytes = await readFile(absolute);
      files.push({
        path: toPosix(path.relative(this.#workspaceRoot, absolute)),
        absent: false,
        dataBase64: bytes.toString('base64'),
        mode: stats.mode & 0o777,
      });
    }

    // A checkpoint over paths that all turned out to be directories or absent
    // is still recorded: "these files did not exist" is a restorable state.
    const id = `${Date.now().toString(36)}-${createHash('sha256')
      .update(label)
      .update(String(files.length))
      .digest('hex')
      .slice(0, 8)}`;
    const record: CheckpointFile = {
      id,
      createdAt: new Date().toISOString(),
      label,
      workspace: this.#workspaceRoot,
      files,
    };

    await mkdir(this.#baseDir, { recursive: true });
    await writeFile(path.join(this.#baseDir, `${id}.json`), `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await this.#prune();

    this.#log.debug('checkpoint created', { id, label, files: files.length });
    return { id, createdAt: record.createdAt, paths: files.map((f) => f.path), label };
  }

  async restore(id: string): Promise<readonly string[]> {
    const record = await this.#read(id);
    const restored: string[] = [];
    for (const file of record.files) {
      const absolute = path.resolve(this.#workspaceRoot, file.path);
      this.#assertInside(absolute, file.path);
      if (file.absent === true || file.dataBase64 === undefined) {
        await rm(absolute, { force: true });
      } else {
        await mkdir(path.dirname(absolute), { recursive: true });
        // `writeFile`'s `mode` applies only when the file is *created*, and
        // restore usually overwrites an existing file — so the stored mode is
        // applied explicitly. Without this the executable bit on a script is
        // silently dropped, which is exactly what a checkpoint exists to
        // prevent.
        await writeFile(absolute, Buffer.from(file.dataBase64, 'base64'));
        await chmod(absolute, file.mode ?? 0o644);
      }
      restored.push(file.path);
    }
    this.#log.debug('checkpoint restored', { id, files: restored.length });
    return restored;
  }

  async list(): Promise<readonly Checkpoint[]> {
    const entries = await readdir(this.#baseDir).catch(() => []);
    const records = await Promise.all(
      entries
        .filter((name) => name.endsWith('.json'))
        .map((name) => this.#read(name.slice(0, -'.json'.length)).catch(() => undefined)),
    );
    return records
      .filter((r): r is CheckpointFile => r !== undefined)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        paths: r.files.map((f) => f.path),
        label: r.label,
      }));
  }

  async latest(): Promise<Checkpoint | undefined> {
    const all = await this.list();
    return all[0];
  }

  async #read(id: string): Promise<CheckpointFile> {
    // The id is used as a filename; reject anything that could traverse.
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(id)) {
      throw new PolicyDeniedError(`Invalid checkpoint id “${id}”.`, {
        details: { id },
      });
    }
    const contents = await readFile(path.join(this.#baseDir, `${id}.json`), 'utf8').catch(
      (cause: unknown) => {
        throw new PolicyDeniedError(`Checkpoint “${id}” was not found.`, {
          cause,
          details: { id },
          hint: 'Run “freecode checkpoints list” to see available checkpoints.',
        });
      },
    );
    return JSON.parse(contents) as CheckpointFile;
  }

  /** Keep only the newest `maxCheckpoints` entries. */
  async #prune(): Promise<void> {
    const entries = (await readdir(this.#baseDir).catch(() => []))
      .filter((name) => name.endsWith('.json'))
      .sort();
    const excess = entries.length - this.#maxCheckpoints;
    if (excess <= 0) return;
    for (const name of entries.slice(0, excess)) {
      await rm(path.join(this.#baseDir, name), { force: true }).catch(() => undefined);
    }
  }

  /** Refuse a path that escapes the workspace, belts-and-braces over PathGuard. */
  #assertInside(absolute: string, relative: string): void {
    const rel = path.relative(this.#workspaceRoot, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PolicyDeniedError(`Refusing to checkpoint “${relative}” outside the workspace.`, {
        details: { relative },
      });
    }
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
