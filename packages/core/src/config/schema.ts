/**
 * Configuration schema.
 *
 * Everything FreeCode reads from a config file is parsed through this module, so
 * there is exactly one place where a setting's type, range and default are
 * defined. Zod is used rather than hand-written validation because the error
 * messages (and their paths) drive the `config show` and `doctor` output.
 *
 * Security invariants enforced here, not in callers
 * -------------------------------------------------
 *   - `security.*` keys are **rejected** in project configuration (see
 *     `loader.ts`). A committed `.freecode/config.json` must never be able to
 *     disable the path guard or auto-approve commands for whoever clones the
 *     repository.
 *   - Timeouts, iteration and token limits all have hard upper bounds. A config
 *     file cannot raise `agent.maxIterations` to `Infinity` and defeat the
 *     runaway-loop protection.
 *   - Provider entries are validated for URL shape at parse time; the SSRF guard
 *     performs the address-level check at connect time (it needs DNS).
 */

import { z } from 'zod';

/** Ports and URLs are validated as strings and parsed by the SSRF guard later. */
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute http(s) URL' },
  );

/** A model reference: `provider/model`, `provider:model`, or a bare model id. */
export const modelRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/\s/.test(value), { message: 'model reference must not contain whitespace' });

export const outputFormatSchema = z.enum(['text', 'json', 'jsonl', 'markdown']);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const logLevelSchema = z.enum(['silent', 'error', 'warn', 'info', 'debug', 'trace']);
export type LogLevelName = z.infer<typeof logLevelSchema>;

/** How much autonomy the agent has over tool calls. */
export const approvalModeSchema = z.enum([
  /** Approve only read-only tools; ask for everything that mutates. */
  'read-only',
  /** Ask before writes and command execution. Default. */
  'ask',
  /** Ask only for commands the policy classifies as destructive or unknown. */
  'auto-safe',
  /** Never ask. Refuses `deny`-tier operations outright. */
  'yolo',
]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

/** How the CLI reaches a model. */
export const accessModeSchema = z.enum([
  /** Direct to provider with the user's own key. Works with no hosted account. */
  'byok',
  /** Provider free tiers used under their own terms. */
  'authorized-free',
  /** Hosted gateway with server-enforced quotas. */
  'hosted',
  /** Try free sources first, fall back to BYOK. Never silently reaches paid. */
  'auto',
]);
export type AccessMode = z.infer<typeof accessModeSchema>;

export const providerConfigSchema = z.object({
  /** Whether this provider is selectable during routing. */
  enabled: z.boolean().default(true),
  /**
   * Base URL. Empty means "use the adapter's built-in default", which is the
   * correct choice for well-known providers and avoids hard-coding endpoints in
   * user configuration.
   */
  baseUrl: z.union([httpUrl, z.literal('')]).default(''),
  /** Adapter kind. `openai-compatible` covers most self-hosted and third-party APIs. */
  type: z
    .enum(['openai-compatible', 'anthropic', 'google', 'ollama', 'gateway', 'custom'])
    .default('openai-compatible'),
  /**
   * Name of the environment variable holding this provider's API key. The key
   * itself is never written to configuration — only the variable name.
   */
  apiKeyEnv: z.string().trim().max(128).optional(),
  /** Explicit model ids. When empty, the provider's catalogue endpoint is used. */
  models: z.array(modelRefSchema).max(500).default([]),
  /** Extra headers sent with every request. Values are redacted from logs. */
  headers: z.record(z.string().max(128), z.string().max(2048)).prefault({}),
  /** Per-request timeout, milliseconds. */
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /** Maximum concurrent in-flight requests to this provider. */
  maxConcurrency: z.number().int().min(1).max(64).default(4),
  /** Whether this provider may be contacted at all without asking. */
  requireApproval: z.boolean().default(false),
  /** Hostnames permitted to resolve to loopback for this provider. */
  allowLoopbackHosts: z.array(z.string().trim().max(253)).max(16).default([]),
  /**
   * How this provider bills. Drives the "never silently switch to paid" rule:
   * a route that would enter the `paid` tier requires explicit consent.
   */
  billing: z.enum(['free', 'free-tier', 'byok', 'paid', 'unknown']).default('unknown'),
  /** Catalogue provenance note shown by `providers list`. */
  notes: z.string().max(500).optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const agentConfigSchema = z.object({
  /**
   * Hard ceiling on agent iterations. Bounded at 100: beyond that the agent is
   * looping rather than working, and each iteration costs tokens.
   */
  maxIterations: z.number().int().min(1).max(100).default(24),
  /** Ceiling on individual tool calls across a session. */
  maxToolCalls: z.number().int().min(1).max(1_000).default(200),
  /** Input+output token budget for a single session. */
  maxTokensPerSession: z.number().int().min(1_000).max(20_000_000).default(400_000),
  /** Wall-clock budget for a single session, milliseconds. */
  maxSessionDurationMs: z
    .number()
    .int()
    .min(10_000)
    .max(24 * 60 * 60 * 1_000)
    .default(30 * 60 * 1_000),
  /** Timeout for a single model request, milliseconds. */
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  /**
   * Overall ceiling on one streaming response, milliseconds. Longer than
   * `requestTimeoutMs` because a reasoning model can legitimately think for a
   * while, and cutting it off mid-answer produces a confusing partial result.
   */
  streamTimeoutMs: z.number().int().min(1_000).max(1_800_000).default(300_000),
  /**
   * Abort a stream that delivers no bytes for this long, milliseconds.
   *
   * This is what actually detects a stalled connection: the overall stream
   * timeout is generous, so without an idle bound a half-open socket would hang
   * the session for minutes.
   */
  streamIdleTimeoutMs: z.number().int().min(1_000).max(600_000).default(90_000),
  /** Timeout for a single shell command, milliseconds. */
  commandTimeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  /** Maximum bytes of command output retained and shown to the model. */
  maxCommandOutputBytes: z.number().int().min(256).max(10_000_000).default(64_000),
  /** Maximum bytes read from a single file into the model context. */
  maxFileReadBytes: z.number().int().min(256).max(10_000_000).default(256_000),
  /** Maximum files returned by one `list_files` call. */
  maxListEntries: z.number().int().min(1).max(10_000).default(1_000),
  /** How many times the same tool call may repeat before the loop is stopped. */
  repeatedCallThreshold: z.number().int().min(2).max(20).default(3),
  /** Whether to stream partial model output as it arrives. */
  stream: z.boolean().default(true),
  /** Sampling temperature passed to providers that accept it. */
  temperature: z.number().min(0).max(2).default(0.2),
  /** Whether the agent may create git checkpoints before mutating files. */
  checkpoints: z.boolean().default(true),
  /** Maximum number of checkpoints retained on disk. */
  maxCheckpoints: z.number().int().min(1).max(500).default(50),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const securityConfigSchema = z.object({
  /** Restrict all file operations to the workspace. Disabling is not supported. */
  confineToWorkspace: z.literal(true).default(true),
  /** Honour `.gitignore` when listing and reading. */
  respectIgnoreFile: z.boolean().default(true),
  /** Whether sensitive files may be read after explicit approval. */
  allowSensitiveReads: z.boolean().default(false),
  /** Whether `.env`/key files may ever be written. Off by default and discouraged. */
  allowProtectedWrites: z.boolean().default(false),
  /** Whether commands classified `allow` run without prompting. */
  autoApproveReadOnly: z.boolean().default(true),
  /** Whether network-fetching commands (`curl`, `wget`) are permitted at all. */
  allowNetworkCommands: z.boolean().default(true),
  /** Extra command basenames considered trusted (still require approval). */
  trustedCommands: z.array(z.string().trim().max(128)).max(100).default([]),
  /** Command basenames that are always refused. */
  deniedCommands: z.array(z.string().trim().max(128)).max(100).default([]),
  /** Maximum redirects followed when contacting a provider. */
  maxRedirects: z.number().int().min(0).max(10).default(5),
  /** Hostnames allowed to resolve to loopback across all providers. */
  allowLoopbackHosts: z.array(z.string().trim().max(253)).max(32).default([]),
  /**
   * Whether to send the workspace file tree to the model as context.
   * Off means the agent must discover structure through tool calls.
   */
  sendWorkspaceContext: z.boolean().default(true),
  /** Maximum entries included in the automatic workspace summary. */
  workspaceContextEntries: z.number().int().min(0).max(2_000).default(200),
});
export type SecurityConfig = z.infer<typeof securityConfigSchema>;

export const approvalConfigSchema = z.object({
  mode: approvalModeSchema.default('ask'),
  /** Whether a single approval covers identical repeated operations. */
  rememberSessionDecisions: z.boolean().default(true),
  /** Whether approvals may be given non-interactively via `--yes`. */
  allowNonInteractiveApproval: z.boolean().default(false),
});
export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;

export const quotaConfigSchema = z.object({
  /** Requests per minute against any provider. */
  requestsPerMinute: z.number().int().min(1).max(10_000).default(60),
  /** Requests per day, per provider. */
  requestsPerDay: z.number().int().min(1).max(1_000_000).default(2_000),
  /** Input tokens per day across all providers. */
  inputTokensPerDay: z.number().int().min(1).max(1_000_000_000).default(2_000_000),
  /** Output tokens per day across all providers. */
  outputTokensPerDay: z.number().int().min(1).max(1_000_000_000).default(500_000),
  /** Concurrent requests across all providers. */
  maxConcurrentRequests: z.number().int().min(1).max(64).default(4),
  /** Whether to stop before exceeding a limit, or warn and continue. */
  enforce: z.boolean().default(true),
  /** Estimated maximum spend in USD for hosted inference. Zero means "free only". */
  maxHostedSpendUsd: z.number().min(0).max(10_000).default(0),
  /** Whether paid models may ever be selected. Off by default. */
  allowPaidModels: z.boolean().default(false),
});
export type QuotaConfig = z.infer<typeof quotaConfigSchema>;

export const routingConfigSchema = z.object({
  /** Whether to prefer free models when the user has not pinned one. */
  preferFree: z.boolean().default(true),
  /** Whether to retry a failed model with a fallback. */
  fallbackEnabled: z.boolean().default(true),
  /** Maximum fallback attempts before surfacing the error. */
  maxFallbacks: z.number().int().min(0).max(10).default(2),
  /**
   * Whether a fallback may cross into a paid provider/model.
   * Default **false**, and the routing engine refuses to cross even when set to
   * true unless `quota.allowPaidModels` is also true and the user has confirmed.
   */
  allowPaidFallback: z.boolean().default(false),
  /** Weights for the routing score. Normalised internally. */
  weights: z
    .object({
      codingSuitability: z.number().min(0).max(10).default(3),
      contextFit: z.number().min(0).max(10).default(2),
      toolSupport: z.number().min(0).max(10).default(2.5),
      reliability: z.number().min(0).max(10).default(2),
      latency: z.number().min(0).max(10).default(1),
      preference: z.number().min(0).max(10).default(1.5),
    })
    .prefault({}),
  /** Whether routing decisions are explained in the output. */
  explain: z.boolean().default(false),
});
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

export const discoveryConfigSchema = z.object({
  /** Whether discovery may contact providers to enumerate models. */
  enabled: z.boolean().default(true),
  /** Whether discovery may issue a minimal completion to verify a model works. */
  verifyCapabilities: z.boolean().default(true),
  /** Maximum tokens requested during a verification call. */
  verificationMaxTokens: z.number().int().min(1).max(256).default(16),
  /** How long a discovery result stays fresh, in milliseconds. */
  cacheTtlMs: z
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60 * 1_000)
    .default(24 * 60 * 60 * 1_000),
  /** After this many consecutive failures, an endpoint is skipped. */
  failureThreshold: z.number().int().min(1).max(100).default(3),
  /** How long an endpoint is skipped after crossing the failure threshold. */
  cooldownMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000)
    .default(15 * 60 * 1_000),
  /** Maximum concurrent probes during a discovery sweep. */
  maxConcurrency: z.number().int().min(1).max(16).default(3),
  /** Whether results are written to the on-disk registry cache. */
  persistCache: z.boolean().default(true),
});
export type DiscoveryConfig = z.infer<typeof discoveryConfigSchema>;

export const gatewayConfigSchema = z.object({
  /** Base URL of the hosted gateway. Empty disables hosted mode. */
  url: z.union([httpUrl, z.literal('')]).default(''),
  /** Whether the CLI should use the gateway when no BYOK key is configured. */
  autoUse: z.boolean().default(false),
  /** Timeout for gateway requests, milliseconds. */
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  /** Requested model when using the gateway; empty means "gateway default". */
  model: z.union([modelRefSchema, z.literal('')]).default(''),
});
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export const outputConfigSchema = z.object({
  format: outputFormatSchema.default('text'),
  /** Whether to colourise terminal output. `auto` respects NO_COLOR and TTY. */
  color: z.enum(['auto', 'always', 'never']).default('auto'),
  /** Whether to render a unified diff after file edits. */
  showDiffs: z.boolean().default(true),
  /** Whether to print each tool call as it happens. */
  showToolActivity: z.boolean().default(true),
  /** Whether to print token usage and estimated cost after each turn. */
  showUsage: z.boolean().default(true),
});
export type OutputConfig = z.infer<typeof outputConfigSchema>;

export const loggingConfigSchema = z.object({
  level: logLevelSchema.default('info'),
  /** `json` emits one object per line; suitable for log collectors. */
  format: z.enum(['text', 'json']).default('text'),
  /** Whether stack traces are printed for unexpected errors. */
  stackTraces: z.boolean().default(false),
  /**
   * Whether debug logging is permitted to include provider request bodies.
   * Default false: request bodies contain the user's source code.
   */
  logRequestBodies: z.boolean().default(false),
});
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

/**
 * The complete validated configuration.
 *
 * `.prefault({})` on every nested object means a completely empty config file is
 * valid and yields the documented defaults — which is what `freecode init`
 * writes, so a user can read the generated file to learn every knob.
 *
 * **Why `prefault` and not `default`.** In Zod 4 a `.default(value)` short-circuits
 * parsing and returns `value` verbatim. `.default({})` on a nested object would
 * therefore hand back a bare `{}`, silently skipping every inner field default —
 * so an empty config file would leave `agent.maxIterations` `undefined` and
 * disable the iteration cap entirely. `.prefault(value)` feeds the value *through*
 * the schema, so the inner defaults are applied. This distinction is a safety
 * property here, not a style choice; see `test/config-defaults.test.ts`.
 */
export const configSchema = z.object({
  /** Schema version, so future migrations can be detected. */
  version: z.literal(1).default(1),
  /** Access mode used when a command does not specify one. */
  accessMode: accessModeSchema.default('auto'),
  /** Pinned default model. Empty means "route automatically". */
  defaultModel: z.union([modelRefSchema, z.literal('')]).default(''),
  /** Pinned default provider. Empty means "infer from defaultModel or route". */
  defaultProvider: z.union([z.string().trim().max(128), z.literal('')]).default(''),
  /** Workspace root override. Empty means "detect from the current directory". */
  workspace: z.union([z.string().trim().max(4096), z.literal('')]).default(''),
  providers: z.record(z.string().trim().min(1).max(64), providerConfigSchema).prefault({}),
  agent: agentConfigSchema.prefault({}),
  security: securityConfigSchema.prefault({}),
  approval: approvalConfigSchema.prefault({}),
  quota: quotaConfigSchema.prefault({}),
  routing: routingConfigSchema.prefault({}),
  discovery: discoveryConfigSchema.prefault({}),
  gateway: gatewayConfigSchema.prefault({}),
  output: outputConfigSchema.prefault({}),
  logging: loggingConfigSchema.prefault({}),
  /** Free-form user metadata preserved across `config set` operations. */
  meta: z.record(z.string().max(64), z.unknown()).prefault({}),
});
export type FreecodeConfig = z.infer<typeof configSchema>;

/** Configuration with every optional field present. Useful for internal typing. */
export type ResolvedConfig = FreecodeConfig;

/**
 * Keys that may **not** appear in a project-scoped configuration file.
 *
 * Rationale: a project config is committed to a repository and is therefore
 * controlled by whoever authored the repository — not by the person running
 * FreeCode. Letting it set `security.confineToWorkspace` or
 * `approval.mode: yolo` would turn cloning a repository into a privilege
 * escalation. `loader.ts` rejects these keys with an explicit error rather than
 * silently ignoring them, because silent ignoring hides the problem from a user
 * who is relying on the setting.
 */
export const PROJECT_FORBIDDEN_PREFIXES: readonly string[] = [
  'security.',
  'approval.',
  'logging.',
  'quota.',
];

/** Keys that must never be written to any configuration file. */
export const NEVER_STORED_KEYS: readonly string[] = [
  'apiKey',
  'api_key',
  'token',
  'secret',
  'password',
];

/** Build a config object from a partial input with all defaults applied. */
export function withDefaults(input: unknown = {}): FreecodeConfig {
  return configSchema.parse(input);
}

/** Deep-partial variant accepted by the loader before defaults are applied. */
export type ConfigInput = z.input<typeof configSchema>;

/**
 * Parse configuration, converting a Zod failure into a message that names the
 * exact offending path. The default Zod message is a JSON blob, which is
 * unhelpful in a terminal.
 */
export function parseConfig(
  input: unknown,
): { ok: true; config: FreecodeConfig } | { ok: false; issues: ConfigIssue[] } {
  const result = configSchema.safeParse(input);
  if (result.success) return { ok: true, config: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
      code: issue.code,
    })),
  };
}

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}
