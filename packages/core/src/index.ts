/**
 * `@freecode/core` — public surface.
 *
 * Consumers (the CLI and the gateway) import only from here. Keeping a single
 * barrel means internal refactors do not ripple into consumers, and it makes the
 * dependency direction enforceable: core never imports from cli or gateway.
 */

// ── Version & errors ────────────────────────────────────────────────────────
export { VERSION, MIN_NODE_MAJOR } from './version.js';
export {
  ExitCode,
  FreecodeError,
  UsageError,
  ConfigError,
  AuthError,
  NetworkError,
  ProviderError,
  ProviderRateLimitError,
  PolicyDeniedError,
  QuotaError,
  InterruptedError,
  toFreecodeError,
  isAbortError,
  isRetryable,
  type ExitCodeValue,
  type FreecodeErrorOptions,
} from './errors.js';

// ── Utilities ───────────────────────────────────────────────────────────────
export {
  REDACTED,
  redact,
  redactPatterns,
  redactValue,
  detectSecrets,
  isSensitiveKey,
  maskTail,
  registerSecret,
  registerSecrets,
  clearRegisteredSecrets,
  registeredSecretCount,
} from './util/redact.js';
export {
  Logger,
  LOG_LEVELS,
  parseLogLevel,
  nullLogger,
  streamSink,
  memorySink,
  type LogLevel,
  type LogFormat,
  type LogRecord,
  type LogSink,
  type LoggerOptions,
} from './util/logger.js';
export {
  abortError,
  anySignal,
  deferred,
  mapConcurrent,
  retry,
  Semaphore,
  sleep,
  waitFor,
  withTimeout,
  type Deferred,
  type RetryOptions,
} from './util/async.js';
export { diffLines, diffStats, formatDiff, type DiffLine, type DiffStats } from './util/diff.js';

// ── Configuration ───────────────────────────────────────────────────────────
export {
  configSchema,
  parseConfig,
  withDefaults,
  providerConfigSchema,
  agentConfigSchema,
  securityConfigSchema,
  approvalConfigSchema,
  quotaConfigSchema,
  routingConfigSchema,
  discoveryConfigSchema,
  gatewayConfigSchema,
  outputConfigSchema,
  loggingConfigSchema,
  accessModeSchema,
  approvalModeSchema,
  PROJECT_FORBIDDEN_PREFIXES,
  type FreecodeConfig,
  type ResolvedConfig,
  type ConfigInput,
  type ConfigIssue,
  type ProviderConfig,
  type AgentConfig,
  type SecurityConfig,
  type ApprovalConfig,
  type ApprovalMode,
  type AccessMode,
  type QuotaConfig,
  type RoutingConfig,
  type DiscoveryConfig,
  type GatewayConfig,
  type OutputConfig,
  type OutputFormat,
  type LoggingConfig,
} from './config/schema.js';
export {
  loadConfig,
  deepMerge,
  getAtPath,
  setAtPath,
  redactConfigForDisplay,
  describeConfigLocations,
  environmentLayer,
  assertProjectConfigAllowed,
  formatIssues,
  ENV_VAR_MAP,
  type LoadedConfig,
  type LoadOptions,
  type ConfigLayer,
} from './config/loader.js';
export {
  APP_NAME,
  PATH_ENV,
  checkpointsDir,
  registryCacheDir,
  cacheHome,
  configHome,
  credentialsPath,
  dataHome,
  findProjectRoot,
  isTermux,
  PROJECT_CONFIG_FILENAMES,
  PROJECT_LOCAL_FILENAMES,
  PROJECT_ROOT_MARKERS,
  sessionsDir,
  usageLedgerPath,
  userConfigPath,
  ancestors,
} from './config/paths.js';

// ── Security ────────────────────────────────────────────────────────────────
export {
  PathGuard,
  isInside,
  assertRegularFile,
  SAFE_WRITE_FLAGS,
  type PathAccess,
  type PathDenial,
  type PathDenialReason,
  type PathGuardOptions,
  type ResolvedPath,
} from './security/path-guard.js';
export {
  classifySensitive,
  isSensitivePath,
  isWriteProtected,
  type SensitiveMatch,
  type SensitivityCategory,
} from './security/sensitive.js';
export {
  IgnoreMatcher,
  compilePattern,
  normalizeForMatch,
  ALWAYS_IGNORED_PATTERNS,
} from './security/ignore.js';
export {
  CommandPolicy,
  assessCommand,
  buildChildEnv,
  splitCommands,
  tokenize,
  SCRUBBED_ENV_VARS,
  type CommandAssessment,
  type CommandCategory,
  type CommandPolicyOptions,
  type CommandVerdict,
} from './security/command-policy.js';
export {
  SsrfGuard,
  classifyAddress,
  expandIpv6,
  inCidrV4,
  ipv4ToInt,
  safeUrlForDisplay,
  BLOCKED_RANGES,
  DEFAULT_LOOPBACK_HOSTS,
  MAX_REDIRECTS,
  type AddressRange,
  type SsrfGuardOptions,
  type ValidatedEndpoint,
} from './security/ssrf-guard.js';

// ── Credentials ─────────────────────────────────────────────────────────────
export {
  FileCredentialStore,
  KeyringCredentialStore,
  assertValidProviderId,
  createCredentialStore,
  describeCredential,
  missingCredentialError,
  resolveApiKey,
  type CredentialSource,
  type CredentialStore,
  type CredentialStoreOptions,
  type ResolvedCredential,
} from './auth/store.js';

// ── Providers ───────────────────────────────────────────────────────────────
export {
  UnsupportedOperationError,
  type AssistantToolCallMessage,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ContentBlock,
  type ModelCapabilities,
  type ModelDescriptor,
  type Provider,
  type ProviderContext,
  type ProviderHealth,
  type ProviderInfo,
  type Role,
  type StopReason,
  type StreamEvent,
  type TextMessage,
  type TokenUsage,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  type ToolResultMessage,
  type VerifiedCapabilities,
} from './providers/types.js';
export {
  HttpClient,
  DEFAULT_MAX_RESPONSE_BYTES,
  ERROR_EXCERPT_BYTES,
  extractProviderMessage,
  parseJsonOrThrow,
  parseRetryAfter,
  readCapped,
  retryAfterMsOf,
  truncate,
  type HttpClientOptions,
  type HttpRequest,
  type HttpResponse,
  type HttpStreamResponse,
} from './providers/http.js';
export {
  SSE_DONE,
  SseParser,
  ToolCallAccumulator,
  decodeEventData,
  isDoneEvent,
  parseEventBlock,
  readSseEvents,
  readSseFromString,
  type ReadSseOptions,
  type SseEvent,
} from './providers/sse.js';
export {
  OpenAiCompatibleProvider,
  textOf,
  toStopReason,
  toToolCalls,
  toUsage,
  toWireMessage,
  type OpenAiCompatibleOptions,
} from './providers/openai-compatible.js';
export {
  AnthropicProvider,
  toStopReason as anthropicToStopReason,
  type AnthropicOptions,
} from './providers/anthropic.js';
export {
  GeminiProvider,
  toStopReason as googleToStopReason,
  type GeminiOptions,
} from './providers/google.js';
export {
  OllamaProvider,
  toStopReason as ollamaToStopReason,
  toToolCalls as ollamaToToolCalls,
  readNdjson,
  readNdjsonFromString,
  type OllamaOptions,
} from './providers/ollama.js';
export {
  BUILT_IN_PROVIDERS,
  ADAPTER_TYPES,
  adapterFor,
  builtInProvider,
  createProvider,
  toProviderInfo,
  type AdapterType,
  type BuiltInProvider,
  type CreateProviderResult,
  type ProviderFactoryOptions,
} from './providers/registry.js';

// ── Model registry & discovery ──────────────────────────────────────────────
export {
  readRegistryCache,
  writeRegistryCache,
  isCacheFresh,
  buildRegistry,
  queryRegistry,
  unionRegistry,
  type ModelRegistryQuery,
  type RegistryCacheEntry,
  type RegistryRow,
} from './models/registry.js';
export {
  discoverProviders,
  refreshRegistry,
  configuredModelIds,
  verifyModel,
  cachedFor,
  isInCooldown,
  recordCooldownFailure,
  type DiscoveryOptions,
  type ProviderDiscoveryResult,
} from './models/discovery.js';

// ── Routing ─────────────────────────────────────────────────────────────────
export {
  FREE_PREFERENCE_WEIGHT,
  buildFallbackChain,
  credentialAvailable,
  pickRoute,
  scoreCandidates,
  type BillingTier,
  type CandidateFacts,
  type PickRouteOptions,
  type RouteCandidate,
  type RouterWeights,
  type RoutingDecision,
  type ScoreOptions,
} from './routing/router.js';
export {
  CATALOGUE_NAMESPACES,
  identifyModel,
  providerFromCatalogue,
  type IdentifyModelResult,
} from './routing/identify.js';

// ── Agent ───────────────────────────────────────────────────────────────────
export { runAgent } from './agent/loop.js';
export {
  Budget,
  describeStopReason,
  type BudgetSnapshot,
  type BudgetState,
} from './agent/budget.js';
export {
  ApprovalManager,
  assessToolCall,
  callSignature,
  allowingApprover,
  denyingApprover,
  type GateVerdict,
} from './agent/approval.js';
export { FileCheckpointManager } from './agent/checkpoint.js';
export {
  createTools,
  ALL_TOOL_SPECS,
  TOOL_NAMES,
  bindSpec,
  bindSpecs,
  ok as toolOk,
  fail as toolFail,
  type ToolContext,
  type ToolSpec,
} from './agent/tools/index.js';
export type {
  AgentDeps,
  AgentEvent,
  AgentEventSink,
  AgentRunOptions,
  AgentRunResult,
  AgentStopReason,
  AgentTool,
  ApprovalDecision,
  ApprovalRequest,
  Approver,
  Checkpoint,
  CheckpointManager,
  ToolDisplay,
  ToolInvocation,
  ToolResult,
} from './agent/types.js';
