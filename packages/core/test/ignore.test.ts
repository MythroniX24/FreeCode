/**
 * gitignore semantics tests.
 *
 * The matcher decides what the agent is allowed to *discover*, so a rule that
 * silently fails to match is a scope leak (the agent reads build output and
 * vendored dependencies) or, worse, a sensitive-file leak when a user relied on
 * `.gitignore` to hide something.
 */

import { describe, expect, it } from 'vitest';

import { IgnoreMatcher } from '../src/security/ignore.js';

describe('basic patterns', () => {
  const matcher = new IgnoreMatcher(['node_modules/', 'dist/', '*.log']);

  it('matches a directory rule against nested files', () => {
    // The most common rule in existence. A naive implementation tests the file
    // path against `node_modules` and misses `node_modules/pkg/index.js`.
    expect(matcher.ignores('node_modules/pkg/index.js')).toBe(true);
    expect(matcher.ignores('node_modules', true)).toBe(true);
  });

  it('does not match a directory rule against a file of the same name', () => {
    // `node_modules/` means "the directory and its contents"; a *file* called
    // `node_modules` is a different thing and must not be swept up by it.
    expect(matcher.ignores('node_modules', false)).toBe(false);
  });

  it('matches a directory rule at any depth when unanchored', () => {
    expect(matcher.ignores('packages/core/dist/bundle.js')).toBe(true);
  });

  it('matches a bare extension glob at any depth', () => {
    expect(matcher.ignores('build.log')).toBe(true);
    expect(matcher.ignores('deep/nested/error.log')).toBe(true);
  });

  it('does not match a partial component', () => {
    // `dist` must not match `distribute.ts`.
    expect(matcher.ignores('distribute.ts')).toBe(false);
  });

  it('does not ignore an unrelated file', () => {
    expect(matcher.ignores('src/index.ts')).toBe(false);
  });
});

describe('anchoring', () => {
  it('anchors a pattern containing a slash to the root', () => {
    const anchored = new IgnoreMatcher(['/build']);
    expect(anchored.ignores('build')).toBe(true);
    expect(anchored.ignores('nested/build')).toBe(false);
  });

  it('anchors a mid-path slash', () => {
    const mid = new IgnoreMatcher(['src/generated']);
    expect(mid.ignores('src/generated')).toBe(true);
    expect(mid.ignores('other/src/generated')).toBe(false);
  });

  it('matches an unanchored pattern anywhere', () => {
    const loose = new IgnoreMatcher(['generated']);
    expect(loose.ignores('generated')).toBe(true);
    expect(loose.ignores('src/generated')).toBe(true);
  });
});

describe('negation', () => {
  it('re-includes a file excluded by an earlier rule', () => {
    const matcher = new IgnoreMatcher(['*.log', '!important.log']);
    expect(matcher.ignores('debug.log')).toBe(true);
    expect(matcher.ignores('important.log')).toBe(false);
  });

  it('lets a later rule win over an earlier negation', () => {
    const matcher = new IgnoreMatcher(['!keep.txt', 'keep.txt']);
    expect(matcher.ignores('keep.txt')).toBe(true);
  });

  it('lets a later negation win over an earlier rule', () => {
    const matcher = new IgnoreMatcher(['keep.txt', '!keep.txt']);
    expect(matcher.ignores('keep.txt')).toBe(false);
  });
});

describe('glob syntax', () => {
  it('supports a single-character wildcard', () => {
    expect(new IgnoreMatcher(['file?.ts']).ignores('file1.ts')).toBe(true);
    expect(new IgnoreMatcher(['file?.ts']).ignores('file12.ts')).toBe(false);
  });

  it('does not let `*` cross a directory boundary', () => {
    expect(new IgnoreMatcher(['src/*.ts']).ignores('src/a.ts')).toBe(true);
    expect(new IgnoreMatcher(['src/*.ts']).ignores('src/nested/a.ts')).toBe(false);
  });

  it('lets `**` cross directory boundaries', () => {
    expect(new IgnoreMatcher(['src/**/*.ts']).ignores('src/a/b/c.ts')).toBe(true);
    expect(new IgnoreMatcher(['**/temp']).ignores('a/b/temp')).toBe(true);
  });

  it('supports a character class', () => {
    expect(new IgnoreMatcher(['file[0-9].ts']).ignores('file5.ts')).toBe(true);
    expect(new IgnoreMatcher(['file[0-9].ts']).ignores('filex.ts')).toBe(false);
  });

  it('supports a negated character class', () => {
    expect(new IgnoreMatcher(['file[!0-9].ts']).ignores('filex.ts')).toBe(true);
    expect(new IgnoreMatcher(['file[!0-9].ts']).ignores('file5.ts')).toBe(false);
  });

  it('treats an unterminated class as a literal bracket', () => {
    expect(new IgnoreMatcher(['file[.ts']).ignores('file[.ts')).toBe(true);
  });

  it('honours a backslash escape', () => {
    const matcher = new IgnoreMatcher(['\\#not-a-comment']);
    expect(matcher.ignores('#not-a-comment')).toBe(true);
  });
});

describe('comments and blanks', () => {
  it('skips blank lines and comments', () => {
    const matcher = new IgnoreMatcher(['', '   ', '# a comment', 'real-rule']);
    expect(matcher.ruleCount).toBe(1);
    expect(matcher.ignores('real-rule')).toBe(true);
  });

  it('parses a .gitignore file body', () => {
    const matcher = IgnoreMatcher.fromFile(
      ['# deps', 'node_modules/', '', '# build', 'dist/', '!dist/keep.js'].join('\n'),
    );
    expect(matcher.ignores('node_modules/x/y.js')).toBe(true);
    expect(matcher.ignores('dist/bundle.js')).toBe(true);
  });
});

describe('edge cases', () => {
  it('never ignores the empty path or the root', () => {
    const matcher = new IgnoreMatcher(['*']);
    expect(matcher.ignores('')).toBe(false);
    expect(matcher.ignores('.')).toBe(false);
  });

  it('normalises Windows separators', () => {
    expect(new IgnoreMatcher(['node_modules/']).ignores('node_modules\\pkg\\index.js')).toBe(true);
  });

  it('collapses duplicate slashes and a leading ./', () => {
    expect(new IgnoreMatcher(['dist/']).ignores('./dist//bundle.js')).toBe(true);
  });

  it('exposes the original patterns for diagnostics', () => {
    const matcher = new IgnoreMatcher(['a/', '!b']);
    expect(matcher.patterns).toEqual(['a/', '!b']);
  });

  it('combines several matchers', () => {
    const combined = IgnoreMatcher.combine(new IgnoreMatcher(['a/']), new IgnoreMatcher(['b/']));
    expect(combined.ignores('a/x')).toBe(true);
    expect(combined.ignores('b/y')).toBe(true);
    expect(combined.ignores('c/z')).toBe(false);
  });

  it('matches a directory-only rule for a directory path', () => {
    const matcher = new IgnoreMatcher(['build/']);
    expect(matcher.ignores('build', true)).toBe(true);
    // A *file* named `build` is not matched by a directory-only rule.
    expect(matcher.ignores('build', false)).toBe(false);
  });
});
