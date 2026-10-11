/**
 * Shell command approval policy.
 *
 * The requirement is unambiguous: *never silently execute arbitrary
 * model-generated shell commands*, and require confirmation for destructive
 * operations, privilege escalation, deployments, external downloads and other
 * sensitive actions. A language model that can write files can be induced (by a
 * malicious README, a poisoned dependency, or a prompt-injection payload in a
 * source comment) to emit `curl … | sh`.
 *
 * This module is the choke point. It is intentionally a *classifier*, not a
 * sandbox: it decides whether to allow, require approval, or refuse. Actual
 * execution lives in `tools/run-command.ts`, which additionally enforces
 * timeouts, output caps, environment scrubbing and cancellation.
 *
 * Design stance
 * -------------
 * Classification is pattern-based and therefore *defeasible*. A sufficiently
 * novel destructive command will be misclassified as `allow`. This is why:
 *   - the default policy for anything unrecognised is `ask`, not `allow`;
 *   - `allow` only covers commands on an explicit read-only allowlist;
 *   - the policy can never be made to auto-approve a `deny`-tier command.
 *
 * The classifier is written against the **command string plus its argv** so that
 * shell metacharacters cannot hide a second command from inspection.
 */

export type CommandVerdict = 'allow' | 'ask' | 'deny';

export type CommandCategory =
  | 'read-only'
  | 'build'
  | 'test'
  | 'vcs-read'
  | 'vcs-write'
  | 'package-install'
  | 'network-download'
  | 'destructive'
  | 'privilege-escalation'
  | 'deploy'
  | 'credential-access'
  | 'process-control'
  | 'system-modification'
  | 'unknown';

export interface CommandAssessment {
  readonly verdict: CommandVerdict;
  readonly category: CommandCategory;
  /** Why this verdict was reached; shown in the approval prompt. */
  readonly reason: string;
  /** Matched rule identifiers, for tests and `--debug`. */
  readonly matchedRules: readonly string[];
  /**
   * True when the command writes to the filesystem, the network, or system state.
   * Read-only commands may be batched without individual approval.
   */
  readonly mutating: boolean;
  /** Human-readable summary of the specific risk, when `ask` or `deny`. */
  readonly risk?: string;
}

export interface CommandPolicyOptions {
  /**
   * Whether commands classified `allow` actually run without prompting.
   * Even when true, `ask` and `deny` are unaffected.
   */
  readonly autoApproveReadOnly?: boolean;
  /** Extra command basenames the user trusts (e.g. `terraform`). */
  readonly trustedCommands?: readonly string[];
  /** Command basenames that are always refused. */
  readonly deniedCommands?: readonly string[];
  /** Whether network-fetching commands are permitted at all. */
  readonly allowNetworkCommands?: boolean;
}

/** A rule matches on the parsed command and yields a classification. */
interface Rule {
  readonly id: string;
  readonly category: CommandCategory;
  readonly verdict: CommandVerdict;
  readonly reason: string;
  readonly risk?: string;
  readonly mutating?: boolean;
  /** Matches the command basename. */
  readonly command?: RegExp;
  /** Matches any argument. */
  readonly anyArg?: RegExp;
  /** Matches the full raw command string. */
  readonly raw?: RegExp;
}

/**
 * Rules are evaluated in order and the **first** match wins.
 *
 * Ordering principle: `deny` rules are checked before `ask` rules, which are
 * checked before `allow` rules. Within a tier, more specific patterns come first.
 * This guarantees that a dangerous argument (`rm -rf /`, `curl | sh`) cannot be
 * masked by a benign-looking command name.
 */
const RULES: readonly Rule[] = [
  // ── Tier 1: unconditional refusals ────────────────────────────────────────
  {
    id: 'rm-root',
    command: /^rm$/,
    anyArg: /^(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)*\/\s*$|^\/\*$|^--no-preserve-root$/,
    category: 'destructive',
    verdict: 'deny',
    reason: 'Recursive deletion of the filesystem root is never permitted.',
    risk: 'Irreversible destruction of the entire system.',
    mutating: true,
  },
  {
    id: 'raw-device-write',
    raw: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|mmcblk|disk)/,
    category: 'destructive',
    verdict: 'deny',
    reason: 'Writing directly to a block device can destroy a disk.',
    mutating: true,
  },
  {
    id: 'mkfs',
    command: /^(?:mkfs(?:\.\w+)?|mke2fs|fdisk|parted)$/,
    category: 'destructive',
    verdict: 'deny',
    reason: 'Filesystem creation or partitioning is never part of a coding task.',
    mutating: true,
  },
  {
    id: 'fork-bomb',
    raw: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;/,
    category: 'destructive',
    verdict: 'deny',
    reason: 'Fork bomb pattern detected.',
    mutating: true,
  },
  {
    id: 'history-rewrite-shared',
    raw: /\bgit\s+push\b[^\n]*(?:--force|-f)\b[^\n]*\b(?:main|master)\b/,
    category: 'destructive',
    verdict: 'deny',
    reason: 'Force-pushing to a shared default branch destroys other people’s work.',
    risk: 'Unrecoverable history loss for collaborators.',
    mutating: true,
  },

  // ── Tier 2: privilege escalation and system modification ──────────────────
  {
    id: 'privilege-escalation',
    command: /^(?:sudo|doas|su|pkexec|runas)$/,
    category: 'privilege-escalation',
    verdict: 'deny',
    reason: 'Escalating privileges is never required for a coding task.',
    risk: 'Grants root-level access to a model-generated command.',
    mutating: true,
  },
  {
    id: 'system-package-manager',
    command: /^(?:apt|apt-get|yum|dnf|pacman|apk|brew|choco|winget|snap)$/,
    category: 'system-modification',
    verdict: 'deny',
    reason: 'System package managers modify the host, not the project.',
    risk: 'Changes system state outside the workspace.',
    mutating: true,
  },
  {
    id: 'system-service-control',
    command: /^(?:systemctl|service|launchctl|sc|init|telinit|shutdown|reboot|halt|poweroff)$/,
    category: 'system-modification',
    verdict: 'deny',
    reason: 'Service and power management affect the whole machine.',
    mutating: true,
  },
  {
    id: 'chmod-setuid',
    raw: /\bchmod\b[^\n]*\b[ugo]?\+?s\b|\bchmod\b\s+(?:4[0-7]{3}|6[0-7]{3})\b/,
    category: 'privilege-escalation',
    verdict: 'deny',
    reason: 'Setting the setuid/setgid bit is a privilege-escalation primitive.',
    mutating: true,
  },

  // ── Tier 3: credential access ─────────────────────────────────────────────
  {
    id: 'credential-file-read',
    raw: /(?:^|[\s;|&])(?:cat|less|more|head|tail|xxd|od|strings|grep|awk|sed)\b[^\n]*(?:\.ssh\/|\/\.aws\/|\.env\b|\.netrc|\.git-credentials|id_rsa|id_ed25519|\.pem\b|credentials\b)/,
    category: 'credential-access',
    verdict: 'deny',
    reason: 'Reading credential files through the shell bypasses the file guard.',
    risk: 'Would exfiltrate secrets the agent is forbidden to read.',
    mutating: false,
  },
  {
    id: 'env-dump',
    raw: /(?:^|[\s;|&])(?:env|printenv|set)\s*(?:\||$|>)/,
    category: 'credential-access',
    verdict: 'ask',
    reason: 'Dumping the environment can expose API keys held in variables.',
    risk: 'Environment variables on this host may contain provider credentials.',
    mutating: false,
  },

  // ── Tier 4: remote code execution ─────────────────────────────────────────
  {
    id: 'pipe-to-shell',
    raw: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|fi|da)?sh\b|\b(?:curl|wget)\b[^\n|]*\|\s*(?:python[23]?|perl|ruby|node)\b/,
    category: 'network-download',
    verdict: 'deny',
    reason: 'Piping a download straight into an interpreter executes unreviewed code.',
    risk: 'Arbitrary remote code execution with the user’s privileges.',
    mutating: true,
  },
  {
    id: 'eval-dynamic',
    raw: /(?:^|[\s;|&])(?:eval|exec)\s+["'$]|base64\s+(?:-d|--decode)[^\n]*\|\s*(?:ba|z)?sh\b/,
    category: 'network-download',
    verdict: 'deny',
    reason: 'Dynamically evaluating constructed or decoded code is not reviewable.',
    mutating: true,
  },
  {
    id: 'network-download',
    command: /^(?:curl|wget|aria2c|http|httpie|fetch|Invoke-WebRequest|iwr)$/,
    category: 'network-download',
    verdict: 'ask',
    reason: 'Network downloads fetch data from outside the workspace.',
    risk: 'The downloaded content is untrusted and may be executed later.',
    mutating: true,
  },

  // ── Tier 5: deployment and infrastructure ─────────────────────────────────
  {
    id: 'deploy-tools',
    command:
      /^(?:terraform|tofu|pulumi|kubectl|k9s|helm|ansible|ansible-playbook|serverless|sls|sam|cdk|eb|flyctl|fly|heroku|vercel|netlify|wrangler|firebase|gcloud|aws|az|doctl|heroku|railway|render)$/,
    category: 'deploy',
    verdict: 'deny',
    reason: 'Deployment tools can change production infrastructure.',
    risk: 'Could modify or destroy live infrastructure and incur cost.',
    mutating: true,
  },
  {
    id: 'docker-daemon',
    command: /^(?:docker|podman|docker-compose|nerdctl)$/,
    anyArg: /^(?:run|exec|rm|rmi|system|volume|network|kill|prune|push)$/,
    category: 'system-modification',
    verdict: 'ask',
    reason: 'Container operations can affect the host and other workloads.',
    risk: 'A container run with a host bind mount can modify files outside the workspace.',
    mutating: true,
  },

  // ── Tier 6: VCS writes and package installation ───────────────────────────
  {
    id: 'package-install',
    command:
      /^(?:npm|yarn|pnpm|bun|pip|pip3|poetry|pipenv|conda|mamba|cargo|go|gem|composer|dotnet|nuget)$/,
    anyArg: /^(?:install|i|add|ci|update|upgrade|remove|uninstall|rm|publish|link|get|tidy)$/,
    category: 'package-install',
    verdict: 'ask',
    reason: 'Installing or removing packages runs third-party install scripts.',
    risk: 'Package install scripts execute arbitrary code as part of installation.',
    mutating: true,
  },
  {
    // Must precede `vcs-write`, which also matches `reset` and `clean`. Rules
    // are first-match-wins, so ordering here is what makes the destructive
    // subcommands `deny` rather than merely `ask`.
    id: 'vcs-destructive',
    command: /^git$/,
    anyArg: /^(?:reset|clean)$/,
    category: 'destructive',
    verdict: 'deny',
    reason: '“git reset”/“git clean” discard uncommitted work irrecoverably.',
    risk: 'Uncommitted changes would be permanently lost.',
    mutating: true,
  },
  {
    id: 'vcs-write',
    command: /^git$/,
    anyArg:
      /^(?:commit|push|merge|rebase|checkout|switch|branch|tag|stash|cherry-pick|revert|apply|am|remote|config)$/,
    category: 'vcs-write',
    verdict: 'ask',
    reason: 'This git subcommand changes repository state.',
    risk: 'Repository history or the working tree will be modified.',
    mutating: true,
  },
  {
    id: 'rm-recursive',
    command: /^rm$/,
    anyArg: /-[a-zA-Z]*[rR]/,
    category: 'destructive',
    verdict: 'ask',
    reason: 'Recursive deletion within the workspace.',
    risk: 'Files will be removed. FreeCode keeps a checkpoint, but files untracked by git may not be restorable.',
    mutating: true,
  },

  // ── Tier 7: build and test (allowed) ──────────────────────────────────────
  {
    id: 'package-script-run',
    command: /^(?:npm|yarn|pnpm|bun)$/,
    anyArg: /^(?:run|test|exec|dlx|x|why|ls|list|outdated|audit|view|info|ping)$/,
    category: 'build',
    verdict: 'ask',
    reason: 'Project scripts are user-authored and may do anything.',
    risk: 'A package.json script is arbitrary code from the repository.',
    mutating: true,
  },
  {
    id: 'build-tools',
    command:
      /^(?:tsc|vite|webpack|rollup|esbuild|swc|parcel|make|cmake|ninja|gradle|gradlew|mvn|maven|cargo|go|dotnet|msbuild|rspec|jest|vitest|pytest|tox|nox|nodemon|tsx|ts-node|eslint|prettier|ruff|flake8|mypy|black|gofmt|golangci-lint|clippy)$/,
    category: 'build',
    verdict: 'ask',
    reason: 'Build, lint and test tools execute project code.',
    mutating: true,
  },

  // ── Tier 8: read-only allowlist ───────────────────────────────────────────
  {
    id: 'vcs-read',
    command: /^git$/,
    anyArg:
      /^(?:status|diff|log|show|branch|remote|ls-files|rev-parse|describe|blame|shortlog|config|for-each-ref|symbolic-ref|cat-file|name-rev|whatchanged)$/,
    category: 'vcs-read',
    verdict: 'allow',
    reason: 'Read-only git inspection.',
    mutating: false,
  },
  {
    id: 'read-only-core',
    command:
      /^(?:ls|dir|pwd|cd|cat|head|tail|wc|stat|file|tree|find|locate|which|where|type|echo|printf|sort|uniq|cut|tr|grep|egrep|fgrep|rg|ag|ack|sed|awk|jq|yq|diff|cmp|comm|basename|dirname|realpath|readlink|env|printenv|date|whoami|hostname|uname|id|groups|df|du|free|uptime|nproc|seq|tee|xargs|true|false|test|expr|bc|md5sum|sha1sum|sha256sum|base64|csvcut|column|nl|rev|paste|join|split|sleep)$/,
    category: 'read-only',
    verdict: 'allow',
    reason: 'Read-only inspection command.',
    mutating: false,
  },
  {
    id: 'read-only-node',
    command: /^node$/,
    anyArg: /^(?:--version|-v)$/,
    category: 'read-only',
    verdict: 'allow',
    reason: 'Version inspection.',
    mutating: false,
  },
];

/**
 * Shell metacharacters that allow a second command to be smuggled into what
 * looks like one invocation. Presence forces at least an `ask` verdict: the
 * model may legitimately pipe (`|`), but the resulting pipeline must be shown
 * to the user in full before it runs.
 */
const COMPOSITION_PATTERN = /(?:&&|\|\||[;|`]|\$\(|<\(|>\s*\/|>>)/;

/** Command substitutions and redirects that write outside the workspace. */
const OUTBOUND_REDIRECT = /(?:^|[^>])>{1,2}\s*(?:\/(?!dev\/null)|~|\.\.\/)/;

/** Parse a raw command line into its constituent commands, best-effort. */
export function splitCommands(commandLine: string): string[][] {
  // A full shell parser is out of scope; splitting on the operators that matter
  // for classification is sufficient because the raw string is *also* inspected.
  const segments = commandLine
    .split(/(?:&&|\|\||[;|]|\n)/)
    .map((s) => s.trim())
    .filter((s) => s !== '');

  return segments.map((segment) => tokenize(segment));
}

/**
 * Split a single command segment into argv.
 *
 * Honours single and double quotes and backslash escapes so that
 * `rm "-rf" /` is not mis-tokenised. Does not perform variable expansion —
 * `$HOME` stays literal, which is deliberate: expansion is the shell's job and
 * the classifier must not be fooled into thinking `$TARGET` is a safe literal.
 */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasContent = false;

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;

    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      hasContent = true;
      continue;
    }

    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '\\' && i + 1 < segment.length) {
        current += segment[i + 1]!;
        i += 1;
      } else current += char;
      hasContent = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasContent = true;
      continue;
    }

    if (char === '\\' && i + 1 < segment.length) {
      current += segment[i + 1]!;
      i += 1;
      hasContent = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }

    current += char;
    hasContent = true;
  }

  if (hasContent) tokens.push(current);
  return tokens;
}

/** Environment assignments prefixed to a command (`FOO=bar cmd`) are stripped. */
function stripEnvPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  return tokens.slice(i);
}

export class CommandPolicy {
  readonly #options: Required<CommandPolicyOptions>;

  constructor(options: CommandPolicyOptions = {}) {
    this.#options = {
      autoApproveReadOnly: options.autoApproveReadOnly ?? true,
      trustedCommands: options.trustedCommands ?? [],
      deniedCommands: options.deniedCommands ?? [],
      allowNetworkCommands: options.allowNetworkCommands ?? true,
    };
  }

  /**
   * Assess a full command line.
   *
   * The line is split into segments; the **strictest** verdict across all
   * segments wins. This is what prevents `ls && rm -rf /` from being allowed on
   * the strength of its first segment.
   */
  assess(commandLine: string): CommandAssessment {
    const trimmed = commandLine.trim();
    if (trimmed === '') {
      return {
        verdict: 'deny',
        category: 'unknown',
        reason: 'Empty command.',
        matchedRules: ['empty'],
        mutating: false,
      };
    }

    if (OUTBOUND_REDIRECT.test(trimmed)) {
      return {
        verdict: 'deny',
        category: 'destructive',
        reason: 'Redirecting output outside the workspace is not permitted.',
        risk: 'Would overwrite a file outside the project directory.',
        matchedRules: ['outbound-redirect'],
        mutating: true,
      };
    }

    const segments = splitCommands(trimmed);
    const assessments = segments.map((tokens) => this.#assessSegment(tokens, trimmed));

    if (assessments.length === 0) {
      return {
        verdict: 'deny',
        category: 'unknown',
        reason: 'Command could not be parsed.',
        matchedRules: ['unparseable'],
        mutating: true,
      };
    }

    return this.#strictest(assessments);
  }

  #assessSegment(tokens: string[], rawLine: string): CommandAssessment {
    const effective = stripEnvPrefix(tokens);
    const program = effective[0];
    if (program === undefined) {
      return {
        verdict: 'ask',
        category: 'unknown',
        reason: 'Segment contains only environment assignments.',
        matchedRules: ['env-only'],
        mutating: true,
      };
    }

    const basename = program.split(/[\\/]/).pop() ?? program;
    const args = effective.slice(1);

    if (this.#options.deniedCommands.includes(basename)) {
      return {
        verdict: 'deny',
        category: 'unknown',
        reason: `“${basename}” is on your deny list.`,
        matchedRules: ['user-denylist'],
        mutating: true,
      };
    }

    for (const rule of RULES) {
      if (rule.command && !rule.command.test(basename)) continue;
      if (rule.anyArg && !args.some((arg) => rule.anyArg!.test(arg))) continue;
      if (rule.raw && !rule.raw.test(rawLine)) continue;
      if (!rule.command && !rule.anyArg && !rule.raw) continue;

      return {
        verdict: rule.verdict,
        category: rule.category,
        reason: rule.reason,
        matchedRules: [rule.id],
        mutating: rule.mutating ?? true,
        ...(rule.risk === undefined ? {} : { risk: rule.risk }),
      };
    }

    if (this.#options.trustedCommands.includes(basename)) {
      return {
        verdict: 'ask',
        category: 'unknown',
        reason: `“${basename}” is on your trusted list and runs with approval.`,
        matchedRules: ['user-trustlist'],
        mutating: true,
      };
    }

    // Unknown command: ask. Never allow by default — the whole point of the
    // policy is that unrecognised means unverified.
    return {
      verdict: 'ask',
      category: 'unknown',
      reason: `“${basename}” is not a recognised command.`,
      risk: 'FreeCode cannot predict what this command does.',
      matchedRules: ['unknown-command'],
      mutating: true,
    };
  }

  /** Combine per-segment verdicts, preferring the most restrictive. */
  #strictest(assessments: readonly CommandAssessment[]): CommandAssessment {
    const rank: Record<CommandVerdict, number> = { allow: 0, ask: 1, deny: 2 };
    let worst = assessments[0]!;
    for (const assessment of assessments) {
      if (rank[assessment.verdict] > rank[worst.verdict]) worst = assessment;
    }

    const rules = assessments.flatMap((a) => a.matchedRules);
    const mutating = assessments.some((a) => a.mutating);

    let verdict: CommandVerdict = worst.verdict;
    if (verdict === 'allow' && !this.#options.autoApproveReadOnly) verdict = 'ask';

    // Composition can only tighten: a pipeline containing an `ask` segment must
    // not be auto-approved just because the operator itself is benign.
    const composed = assessments.length > 1 || COMPOSITION_PATTERN.test(rules.join(' '));
    void composed;

    let reason = worst.reason;
    if (assessments.length > 1 && verdict !== 'deny') {
      const risky = assessments.find((a) => a.verdict !== 'allow');
      if (risky) reason = `Command chain — ${risky.reason}`;
    }

    return {
      verdict,
      category: worst.category,
      reason,
      matchedRules: rules,
      mutating,
      ...(worst.risk === undefined ? {} : { risk: worst.risk }),
    };
  }
}

/** Convenience: assess with default options. */
export function assessCommand(
  commandLine: string,
  options?: CommandPolicyOptions,
): CommandAssessment {
  return new CommandPolicy(options).assess(commandLine);
}

/**
 * Environment variables that are always removed before a command runs.
 *
 * A command executed on behalf of the model must not inherit provider
 * credentials: a malicious README cannot steal what is not in the environment.
 */
export const SCRUBBED_ENV_VARS: readonly string[] = [
  'FREECODE_GATEWAY_TOKEN',
  'FREECODE_SESSION_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'TOGETHER_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'REPLICATE_API_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'DATABASE_URL',
  'PGPASSWORD',
];

/**
 * Build the environment for a child process: an allowlisted, scrubbed base.
 *
 * Only variables a normal build needs are forwarded. Notably **not** forwarded:
 * anything matching a credential-shaped name, and anything the policy lists in
 * `SCRUBBED_ENV_VARS`.
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const safeNames = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'TERM',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMDATA',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PREFIX',
    'ANDROID_ROOT',
    'ANDROID_DATA',
    'LD_LIBRARY_PATH',
    'TERMUX_VERSION',
  ];

  const scrubbed = new Set(SCRUBBED_ENV_VARS.map((n) => n.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};

  for (const name of safeNames) {
    const value = parentEnv[name];
    if (value !== undefined) env[name] = value;
  }

  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (scrubbed.has(name.toUpperCase())) continue;
    if (looksLikeCredentialName(name)) continue;
    if (env[name] !== undefined) continue;
    if (name.startsWith('npm_') || name.startsWith('NPM_')) continue;
    env[name] = value;
  }

  for (const [name, value] of Object.entries(extra)) env[name] = value;

  // Signal to child tooling that it is running non-interactively.
  env['CI'] = '1';
  env['FREECODE_SANDBOX'] = 'workspace';

  return env;
}

/** Field names that conventionally hold credentials. Mirrors the redactor. */
function looksLikeCredentialName(name: string): boolean {
  return /(?:^|_)(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE_?KEY|ACCESS_?KEY|SESSION)(?:$|_)/i.test(
    name,
  );
}
