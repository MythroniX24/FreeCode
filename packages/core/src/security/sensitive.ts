/**
 * Sensitive-file classification.
 *
 * "Never automatically read `.env`, private keys, credentials" is a hard
 * requirement, and it is enforced in three independent places so that no single
 * mistake defeats it:
 *
 *   1. `PathGuard.resolve()` refuses the path outright (see `path-guard.ts`).
 *   2. The agent's `read_file` tool asks for explicit approval when the policy
 *      permits overriding.
 *   3. The redactor masks anything that nonetheless reaches a log line.
 *
 * Classification is by filename pattern *and* by content, because the highest-risk
 * files are frequently misnamed (`config.json` holding an API key, `.npmrc`
 * holding an auth token).
 */

export type SensitivityCategory =
  | 'environment'
  | 'credential'
  | 'private-key'
  | 'certificate'
  | 'package-manager-auth'
  | 'cloud-credentials'
  | 'shell-history'
  | 'database'
  | 'unknown';

export interface SensitiveMatch {
  readonly category: SensitivityCategory;
  /** Human-readable explanation shown in the approval prompt. */
  readonly reason: string;
  /**
   * Whether the file may be read with explicit user approval, or is refused
   * unconditionally. Private keys and cloud credential stores are the latter:
   * there is no legitimate reason for a coding agent to read them.
   */
  readonly overrideable: boolean;
}

interface FilenameRule {
  readonly pattern: RegExp;
  readonly category: SensitivityCategory;
  readonly reason: string;
  readonly overrideable?: boolean;
}

/**
 * Suffixes that mark a template rather than a live file.
 *
 * `.env.example`, `.env.sample` and friends are committed to repositories
 * precisely so they contain *no* secrets — they are the documented shape of the
 * real file. Refusing to read them would block the most useful file in a new
 * repository while protecting nothing.
 */
const TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist|defaults?|schema|test)$/i;

/** Basename rules, evaluated against the final path segment. */
const FILENAME_RULES: readonly FilenameRule[] = [
  {
    pattern: /^\.env(\.|$)/i,
    category: 'environment',
    reason: 'environment file may contain API keys and database credentials',
  },
  {
    pattern: /^\.env$/i,
    category: 'environment',
    reason: 'environment file may contain API keys and database credentials',
  },
  {
    pattern: /\.(pem|key|p8|p12|pfx|jks|keystore)$/i,
    category: 'private-key',
    reason: 'private key material',
    overrideable: false,
  },
  {
    pattern: /^id_(rsa|dsa|ecdsa|ed25519)$/i,
    category: 'private-key',
    reason: 'SSH private key',
    overrideable: false,
  },
  {
    pattern: /^\.?(npmrc|yarnrc|yarnrc\.yml|pnpmrc)$/i,
    category: 'package-manager-auth',
    reason: 'package manager config may embed a registry auth token',
  },
  {
    pattern: /^\.netrc$/i,
    category: 'credential',
    reason: 'netrc stores plaintext credentials',
    overrideable: false,
  },
  {
    pattern: /^\.git-credentials$/i,
    category: 'credential',
    reason: 'git credential store',
    overrideable: false,
  },
  {
    pattern: /^\.?(aws|gcloud|azure)\b/i,
    category: 'cloud-credentials',
    reason: 'cloud provider credentials',
    overrideable: false,
  },
  {
    pattern: /^credentials(\.json|\.yml|\.yaml)?$/i,
    category: 'cloud-credentials',
    reason: 'cloud credentials file',
    overrideable: false,
  },
  {
    pattern: /^(\.bash_history|\.zsh_history|\.python_history|\.node_repl_history)$/i,
    category: 'shell-history',
    reason: 'shell history frequently contains pasted secrets',
  },
  {
    pattern: /^\.(htpasswd|pgpass|my\.cnf)$/i,
    category: 'credential',
    reason: 'database or web-server credential file',
    overrideable: false,
  },
  {
    pattern: /^service[-_]?account.*\.json$/i,
    category: 'cloud-credentials',
    reason: 'cloud service account key',
    overrideable: false,
  },
  {
    pattern: /^(secrets?|\.secrets?)(\.json|\.yml|\.yaml|\.toml)?$/i,
    category: 'credential',
    reason: 'file named as a secret store',
  },
  {
    pattern: /^\.terraformrc$/i,
    category: 'cloud-credentials',
    reason: 'Terraform CLI config may embed registry tokens',
  },
];

/** Directory segments: any path containing one of these is sensitive. */
const SENSITIVE_DIRECTORIES: readonly {
  segment: string;
  category: SensitivityCategory;
  reason: string;
  overrideable?: boolean;
}[] = [
  { segment: '.ssh', category: 'private-key', reason: 'SSH key directory', overrideable: false },
  { segment: '.gnupg', category: 'private-key', reason: 'GPG keyring', overrideable: false },
  {
    segment: '.aws',
    category: 'cloud-credentials',
    reason: 'AWS credentials directory',
    overrideable: false,
  },
  {
    segment: '.kube',
    category: 'cloud-credentials',
    reason: 'Kubernetes credentials directory',
    overrideable: false,
  },
  {
    segment: '.docker',
    category: 'credential',
    reason: 'Docker config may hold registry credentials',
  },
];

/**
 * Content-based detection, applied to the *first* chunk of a file before it is
 * fully read. This catches secrets in innocuously-named files, which is the case
 * filename rules cannot cover.
 *
 * Deliberately conservative: these patterns target high-confidence credential
 * formats only. A false positive here blocks a legitimate read, so generic
 * "long string" heuristics are excluded.
 */
const CONTENT_RULES: readonly { pattern: RegExp; category: SensitivityCategory; reason: string }[] =
  [
    {
      pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
      category: 'private-key',
      reason: 'contains a PEM private key',
    },
    {
      pattern: /\bAKIA[0-9A-Z]{16}\b/,
      category: 'cloud-credentials',
      reason: 'contains an AWS access key id',
    },
    {
      pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/,
      category: 'credential',
      reason: 'contains an Anthropic API key',
    },
    {
      pattern: /\bsk-[A-Za-z0-9]{32,}\b/,
      category: 'credential',
      reason: 'contains an API key',
    },
    {
      pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
      category: 'credential',
      reason: 'contains a GitHub token',
    },
    {
      pattern: /^\s*[A-Z0-9_]*API[_-]?KEY\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/m,
      category: 'credential',
      reason: 'assigns a literal API key',
    },
    {
      pattern:
        /^\s*[A-Z0-9_]*(SECRET|PASSWORD|PASSWD|TOKEN)[A-Z0-9_]*\s*[:=]\s*["']?[^\s"'{}$<]{12,}/m,
      category: 'credential',
      reason: 'assigns a literal secret value',
    },
  ];

/**
 * Classify a path (and optionally its leading content) as sensitive.
 *
 * `basename` is examined against filename rules; every path segment is examined
 * against directory rules; `contentHead` (the first few KB) is examined against
 * content rules when supplied.
 */
export function classifySensitive(
  relativePath: string,
  contentHead?: string,
): SensitiveMatch | undefined {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const basename = segments.at(-1) ?? '';

  // A template of a sensitive file is not itself sensitive, so it short-circuits
  // *both* the filename and directory rules (`.env.example` under `.ssh/` is
  // still a documented template, though that combination is unlikely).
  const isTemplate = TEMPLATE_SUFFIX.test(basename);

  for (const rule of FILENAME_RULES) {
    if (rule.pattern.test(basename)) {
      if (isTemplate) return undefined;
      return {
        category: rule.category,
        reason: `“${basename}” ${rule.reason}`,
        overrideable: rule.overrideable ?? true,
      };
    }
  }

  for (const segment of segments) {
    const hit = SENSITIVE_DIRECTORIES.find((d) => d.segment === segment);
    if (hit) {
      return {
        category: hit.category,
        reason: `path is inside “${hit.segment}/” — ${hit.reason}`,
        overrideable: hit.overrideable ?? true,
      };
    }
  }

  if (contentHead !== undefined && contentHead !== '') {
    for (const rule of CONTENT_RULES) {
      if (rule.pattern.test(contentHead)) {
        return {
          category: rule.category,
          reason: `file contents ${rule.reason}`,
          // Content-detected secrets can be re-read with approval: the file
          // itself may be a fixture or a redacted example.
          overrideable: true,
        };
      }
    }
  }

  return undefined;
}

/** Convenience predicate when only a boolean is needed. */
export function isSensitivePath(relativePath: string, contentHead?: string): boolean {
  return classifySensitive(relativePath, contentHead) !== undefined;
}

/**
 * Files that must never be *written* by the agent even if reading is approved.
 * Overwriting a developer's `.env` or key material is destructive and is never
 * part of a legitimate refactor.
 */
export function isWriteProtected(relativePath: string): boolean {
  const match = classifySensitive(relativePath);
  if (!match) return false;
  return (
    match.category === 'private-key' ||
    match.category === 'cloud-credentials' ||
    match.category === 'credential' ||
    match.category === 'environment'
  );
}
