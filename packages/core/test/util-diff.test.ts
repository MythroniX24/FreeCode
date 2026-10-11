/**
 * The line diff behind `edit_file`'s display.
 *
 * Small and dependency-free, so the properties that matter are the ones a user
 * would notice: identical input shows no changes, a pure addition is reported
 * as an addition, and a change far from the top is not accompanied by the whole
 * file.
 */

import { describe, expect, it } from 'vitest';

import { diffLines, diffStats, formatDiff } from '../src/util/diff.js';

describe('diffLines', () => {
  it('treats identical input as all context', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(lines.every((line) => line.kind === 'context')).toBe(true);
    expect(lines.map((line) => line.text)).toEqual(['a', 'b', 'c']);
  });

  it('reports a substituted line as one removal and one addition', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    const stats = diffStats(lines);
    expect(stats).toEqual({ added: 1, removed: 1 });
    expect(lines.find((line) => line.kind === 'add')!.text).toBe('B');
    expect(lines.find((line) => line.kind === 'remove')!.text).toBe('b');
  });

  it('reports a pure addition', () => {
    const lines = diffLines('a\nc\n', 'a\nb\nc\n');
    expect(diffStats(lines)).toEqual({ added: 1, removed: 0 });
  });

  it('reports a pure deletion', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nc\n');
    expect(diffStats(lines)).toEqual({ added: 0, removed: 1 });
  });

  it('diffing an empty file against content adds every line', () => {
    const lines = diffLines('', 'one\ntwo\n');
    expect(diffStats(lines)).toEqual({ added: 2, removed: 0 });
  });

  it('does not treat a trailing newline as a changed line', () => {
    expect(diffStats(diffLines('a\nb\n', 'a\nb'))).toEqual({ added: 0, removed: 0 });
  });
});

describe('formatDiff', () => {
  it('prints a unified header and prefixes each line by kind', () => {
    const text = formatDiff('src/a.ts', diffLines('a\nb\n', 'a\nB\n'));
    expect(text).toContain('--- src/a.ts');
    expect(text).toContain('+++ src/a.ts');
    expect(text).toContain('-b');
    expect(text).toContain('+B');
    expect(text).toContain(' a'); // the unchanged line keeps a leading space
  });

  it('says so plainly when there are no changes', () => {
    expect(formatDiff('a.ts', diffLines('x\n', 'x\n'))).toContain('(no changes)');
  });

  it('elides distant unchanged lines rather than printing the whole file', () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 100', 'CHANGED');
    const text = formatDiff('big.ts', diffLines(`${before}\n`, `${after}\n`));
    // The file is 200 lines; only a window around the change should appear.
    expect(text.split('\n').length).toBeLessThan(50);
    expect(text).toContain('-line 100');
    expect(text).toContain('+CHANGED');
  });
});
