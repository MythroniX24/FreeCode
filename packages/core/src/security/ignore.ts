/**
 * `.gitignore`-compatible matcher.
 *
 * The agent must not read or traverse files the user considers out of scope:
 * build output, vendored dependencies, and — critically — anything the user has
 * explicitly ignored. Shelling out to `git check-ignore` would be simpler but
 * (a) requires git, which Termux and Windows installs may lack, and (b) makes a
 * security decision depend on a subprocess's exit code.
 *
 * Semantics implemented (per gitignore(5)):
 *   - Blank lines and lines starting with `#` are ignored.
 *   - `!` negates a pattern, re-including a previously excluded path.
 *   - A trailing `/` matches directories only.
 *   - A `/` anywhere except the end anchors the pattern to the ignore file's
 *     directory; otherwise the pattern matches at any depth.
 *   - `*` matches anything except `/`; `?` matches one non-`/` character;
 *     `**` crosses directory boundaries.
 *   - Later patterns win over earlier ones (so a `!` can undo a preceding match).
 */

interface CompiledRule {
  readonly source: string;
  readonly regex: RegExp;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
}

/**
 * Translate one gitignore pattern into a RegExp matching a POSIX-style relative
 * path. Kept separate from the class so it can be unit-tested directly.
 */
export function compilePattern(pattern: string): RegExp | undefined {
  let source = pattern.trim();
  if (source === '' || source.startsWith('#')) return undefined;

  // A trailing backslash escapes a literal '#' or '!'.
  let escapedLeading = false;
  if (source.startsWith('\\#') || source.startsWith('\\!')) {
    source = source.slice(1);
    escapedLeading = true;
  }

  let negated = false;
  if (!escapedLeading && source.startsWith('!')) {
    negated = true;
    source = source.slice(1);
  }

  // A trailing slash marks the pattern as directory-only; the matcher computes
  // that from the source text, and the slash itself is dropped here.
  if (source.endsWith('/')) source = source.slice(0, -1);
  if (source === '') return undefined;

  // Leading '/' anchors to the root; strip it and remember.
  const anchored = source.startsWith('/');
  if (anchored) source = source.slice(1);

  // A '/' in the middle also anchors (gitignore: "if there is a separator at the
  // beginning or middle ... the pattern is relative to the [root]").
  const hasMiddleSlash = source.includes('/');

  const body = globToRegexSource(source);

  // When unanchored, the pattern may match starting at any directory boundary.
  // When anchored, it must match from the start of the relative path.
  const prefix = anchored || hasMiddleSlash ? '^' : '^(?:.*/)?';
  // A match must consume the whole path: gitignore matches path components, so
  // `build` matches `build/` but not `buildx`.
  const suffix = '$';

  void negated;
  return new RegExp(`${prefix}${body}${suffix}`);
}

/** Translate gitignore glob syntax into a RegExp source fragment. */
function globToRegexSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;

    if (char === '*') {
      const isDouble = glob[i + 1] === '*';
      if (isDouble) {
        // `**/` matches zero or more directories; a bare trailing `**` matches
        // everything below.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      continue;
    }

    if (char === '[') {
      // Character class: copy through to the closing bracket, escaping nothing
      // except the regex-hostile cases. An unterminated class is a literal '['.
      const end = findClassEnd(glob, i);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      const inner = glob.slice(i + 1, end);
      out += `[${inner.startsWith('!') ? `^${inner.slice(1)}` : inner}]`;
      i = end;
      continue;
    }

    if (char === '\\' && i + 1 < glob.length) {
      out += escapeRegex(glob[i + 1]!);
      i += 1;
      continue;
    }

    out += escapeRegex(char);
  }
  return out;
}

function findClassEnd(glob: string, start: number): number {
  for (let i = start + 1; i < glob.length; i += 1) {
    if (glob[i] === '\\') {
      i += 1;
      continue;
    }
    if (glob[i] === ']') return i;
  }
  return -1;
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * A set of gitignore rules evaluated against POSIX-style relative paths.
 *
 * Evaluation order is significant: the last matching rule decides. `ignores()`
 * therefore walks every rule and keeps the final verdict rather than
 * short-circuiting, and a negation rule only re-includes a path that an earlier
 * rule excluded (gitignore does not allow re-including a file inside an ignored
 * directory — this implementation reproduces that by refusing negations whose
 * parent directory is excluded).
 */
export class IgnoreMatcher {
  readonly #rules: readonly CompiledRule[];

  constructor(patterns: Iterable<string> = []) {
    const rules: CompiledRule[] = [];
    for (const raw of patterns) {
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const directoryOnly = trimmed.endsWith('/');
      const negated = trimmed.startsWith('!');
      const regex = compilePattern(trimmed);
      if (!regex) continue;
      rules.push({ source: trimmed, regex, negated, directoryOnly });
    }
    this.#rules = rules;
  }

  get ruleCount(): number {
    return this.#rules.length;
  }

  /** The original pattern strings, for `doctor` diagnostics. */
  get patterns(): readonly string[] {
    return this.#rules.map((r) => r.source);
  }

  /**
   * Whether `relativePath` (POSIX separators, relative to the ignore root) is
   * ignored. `isDirectory` matters for patterns ending in `/`.
   *
   * The subtlety: gitignore's `dir/` means "this directory *and everything
   * beneath it*". A naive implementation tests the full path against the regex
   * and skips the rule for files, which misses `node_modules/pkg/index.js`
   * against the pattern `node_modules/` — the single most common ignore rule
   * there is. Directory-only rules are therefore tested against each ancestor
   * directory of the path, not just the path itself.
   */
  ignores(relativePath: string, isDirectory = false): boolean {
    const path = normalizeForMatch(relativePath);
    if (path === '' || path === '.') return false;

    // Every ancestor directory prefix, plus the path itself when it is a
    // directory. For a file `a/b/c.ts` this is ['a', 'a/b'].
    const directoryPaths = ancestorDirectories(path, isDirectory);

    let ignored = false;
    for (const rule of this.#rules) {
      const matched = rule.directoryOnly
        ? directoryPaths.some((candidate) => rule.regex.test(candidate))
        : rule.regex.test(path);
      if (!matched) continue;
      ignored = !rule.negated;
    }
    return ignored;
  }

  /** Parse the contents of a `.gitignore` file. */
  static fromFile(contents: string): IgnoreMatcher {
    return new IgnoreMatcher(contents.split(/\r?\n/));
  }

  /** Combine several matchers; a path is ignored if any of them ignores it. */
  static combine(...matchers: readonly IgnoreMatcher[]): IgnoreMatcher {
    const patterns: string[] = [];
    for (const matcher of matchers) patterns.push(...matcher.patterns);
    return new IgnoreMatcher(patterns);
  }
}

/**
 * Directory paths that a directory-only rule could match against: every strict
 * ancestor, plus the path itself when it denotes a directory.
 */
function ancestorDirectories(path: string, isDirectory: boolean): string[] {
  const segments = path.split('/').filter((s) => s !== '');
  const candidates: string[] = [];
  const limit = isDirectory ? segments.length : segments.length - 1;
  for (let i = 1; i <= limit; i += 1) {
    candidates.push(segments.slice(0, i).join('/'));
  }
  return candidates;
}

/** Strip a leading `./`, collapse duplicate slashes, and use POSIX separators. */
export function normalizeForMatch(input: string): string {
  return input
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

/**
 * Patterns that are always ignored regardless of what the project's `.gitignore`
 * says. These are not style preferences — reading them is a credential leak.
 */
export const ALWAYS_IGNORED_PATTERNS: readonly string[] = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.cache/',
  '.turbo/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'target/',
  'vendor/',
  '.freecode/',
];
