/**
 * A minimal line diff for tool output.
 *
 * Not a general-purpose diff: it exists so `edit_file` can show a user what
 * changed without pulling in a dependency, and so the same result is available
 * to the JSON output mode. A longest-common-subsequence over lines is more than
 * enough for the files an agent edits, and being dependency-free keeps the
 * install surface small — a deliberate trade against a fancier algorithm.
 */

/** One line of a diff, tagged with its role. */
export interface DiffLine {
  readonly kind: 'context' | 'add' | 'remove';
  readonly text: string;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
}

const MAX_LCS_CELLS = 4_000_000;

/**
 * Compute a line diff between two strings.
 *
 * Falls back to a coarse "replace everything" rendering when the inputs are so
 * large that the quadratic LCS table would be unreasonable — a diff that is slow
 * to produce is worse than one that is merely inelegant.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'remove', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }

  // Standard LCS table, then a backtrace.
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: 'remove', text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: 'remove', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

/** Count additions and removals. */
export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'remove') removed += 1;
  }
  return { added, removed };
}

/**
 * Render a unified-style diff with `path` in the header.
 *
 * `context` lines are elided around the changes when the file is large: a diff
 * of a 5000-line file that changed one line should not print 5000 lines. The
 * `contextLines` window matches the familiar `diff -u` default.
 */
export function formatDiff(
  path: string,
  lines: readonly DiffLine[],
  options: { readonly contextLines?: number; readonly maxLines?: number } = {},
): string {
  const context = options.contextLines ?? 3;
  const maxLines = options.maxLines ?? 400;

  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  const header = `--- ${path}\n+++ ${path}`;
  if (keep.size === 0) return `${header}\n(no changes)`;

  const out: string[] = [header];
  let previous = -2;
  let emitted = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!keep.has(index)) continue;
    if (emitted >= maxLines) {
      out.push(`… ${lines.length - index} more lines elided`);
      break;
    }
    if (index !== previous + 1) out.push('@@');
    const line = lines[index]!;
    const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
    out.push(`${prefix}${line.text}`);
    previous = index;
    emitted += 1;
  }
  return out.join('\n');
}

function splitLines(value: string): string[] {
  if (value === '') return [];
  return value.replace(/\n$/, '').split('\n');
}
