# Architecture

> **Design for correctness, security, and maintainability.**

FreeCode is architected as a modular TypeScript monorepo with three main packages:
`@freecode/core`, `@freecode/cli`, and `@freecode/gateway`. This document explains
the system design, component relationships, and key architectural decisions.

---

## Repository Structure

```
freecode/
├── packages/
│   ├── core/               # Shared types, utilities, security, providers
│   │   ├── src/
│   │   │   ├── config/     # Configuration schemas and paths
│   │   │   ├── providers/  # Provider adapters and registry
│   │   │   ├── security/   # SSRF guard, path guard, redaction
│   │   │   ├── auth/       # Credential store interface
│   │   │   ├── util/       # Logger, async utilities, errors
│   │   │   └── index.ts    # Public API exports
│   │   └── test/           # Core unit tests
│   │
│   ├── cli/                # Command-line interface
│   │   ├── src/
│   │   │   ├── commands/   # CLI commands (run, config, doctor)
│   │   │   ├── agent/      # Agent kernel (budget, approval, loop)
│   │   │   ├── tools/      # Tool implementations
│   │   │   └── index.ts    # CLI entry point
│   │   └── test/           # CLI tests
│   │
│   └── gateway/            # Hosted gateway server
│       ├── src/
│       │   ├── config.ts   # Gateway configuration parsing
│       │   ├── server/     # Fastify app, routes, auth, errors
│       │   ├── quota/      # Quota limiter
│       │   ├── store/      # Usage ledger (memory, postgres)
│       │   └── upstream/    # Catalogue, provider resolver
│       ├── test/           # Gateway tests
│       │   └── helpers/    # Test harness and stub provider
│       └── migrations/     # Database migrations
│
├── scripts/                # Build and development scripts
│   └── mirror.mjs           # Cross-device build mirroring
│
├── docs/                   # Documentation
│   ├── architecture.md     # This file
│   ├── security.md         # Security constraints and threat model
│   └── testing.md          # Testing strategy
│
├── examples/               # Usage examples
│
├── vitest.config.ts        # Root Vitest configuration
├── vitest.gateway.config.ts # Gateway-specific Vitest configuration
├── tsconfig.json           # Root TypeScript configuration
├── tsconfig.base.json      # Base TypeScript options
├── tsconfig.check.json      # Type-check only configuration
├── eslint.config.mjs       # ESLint configuration
└── package.json            # Root package with workspaces
```

---

## Package Dependencies

```
┌─────────────────────────────────────────────────────────────┐
│                      @freecode/cli                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  commands/          agent/              tools/           │ │
│  │    run.ts            kernel.ts          bash.ts          │ │
│  │    config.ts         budget.ts          read.ts          │ │
│  │    doctor.ts         approval.ts        write.ts         │ │
│  │                     checkpoints.ts      edit.ts          │ │
│  │                     loop.ts             web-fetch.ts     │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ imports
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      @freecode/core                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  config/            providers/          security/         │ │
│  │    schema.ts         registry.ts        ssrf-guard.ts    │ │
│  │    paths.ts          http.ts           path-guard.ts    │ │
│  │                       anthropic.ts       redact.ts        │ │
│  │                       google.ts                          │ │
│  │                       ollama.ts                          │ │
│  │  auth/               util/               errors.ts        │ │
│  │    store.ts          logger.ts                          │ │
│  │                       async.ts                           │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ imports (for types)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      @freecode/gateway                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  config.ts           server/              quota/         │ │
│  │                       app.ts               limiter.ts    │ │
│  │                       routes/              store/         │ │
│  │                         chat.ts             memory.ts     │ │
│  │                         models.ts           postgres.ts   │ │
│  │                         usage.ts                          │ │
│  │                       auth.ts                            │ │
│  │                       deps.ts                             │ │
│  │                       errors.ts                           │ │
│  │                       wire.ts                             │ │
│  │                    upstream/                            │ │
│  │                      catalogue.ts                        │ │
│  │                      resolver.ts                         │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Core Package (`@freecode/core`)

The core package contains shared types, utilities, and provider adapters that are
used by both the CLI and the gateway.

### Key Modules

#### `config/` — Configuration

- **`schema.ts`**: Zod schemas for all configuration objects
  - `providerConfigSchema` — Provider configuration
  - `quotaConfigSchema` — Quota configuration
  - `gatewayConfigSchema` — Gateway client configuration
  - `agentConfigSchema` — Agent configuration

- **`paths.ts`**: File path constants and resolution
  - `DEFAULT_CONFIG_PATH` — Default config file path
  - `resolveConfigPath()` — Resolve config path with overrides

#### `providers/` — Provider Adapters

The provider system uses a registry pattern with adapters for each provider type.

- **`types.ts`**: Core provider types
  - `Provider` — Interface all providers implement
  - `ProviderInfo` — Provider metadata
  - `ProviderConfig` — Configuration for a provider
  - `ModelDescriptor` — Model information
  - `ChatRequest`, `ChatResponse` — Request/response types
  - `StreamEvent` — Streaming event types

- **`registry.ts`**: Provider registry
  - `ADAPTER_TYPES` — Supported adapter types
  - `BUILT_IN_PROVIDERS` — Built-in provider configurations
  - `ProviderRegistry` — Registry of provider factories
  - `adapterFor()` — Get adapter for a provider type

- **`http.ts`**: HTTP provider adapter (OpenAI-compatible)
  - Handles generic OpenAI-compatible endpoints
  - Supports streaming and non-streaming
  - Configurable base URL, headers, timeouts

- **`sse.ts`**: SSE (Server-Sent Events) utilities
  - `SSE_DONE` — End-of-stream sentinel
  - `parseSse()` — Parse SSE frames from a stream
  - `streamSse()` — Create an SSE stream from events

- **Native adapters**:
  - `anthropic.ts` — Anthropic Messages API
  - `google.ts` — Google Vertex AI
  - `ollama.ts` — Ollama local inference

#### `security/` — Security Primitives

- **`ssrf-guard.ts`**: SSRF (Server-Side Request Forgery) protection
  - `SsrfGuard` class with configurable allowed hosts
  - `DEFAULT_LOOPBACK_HOSTS` — localhost, 127.0.0.1, [::1]
  - `allowInsecureLoopback` — Allow loopback addresses
  - `check()` — Validate a URL against the guard

- **`path-guard.ts`**: File system path validation
  - `PathGuard` class for path confinement
  - `resolve()` — Resolve and validate paths
  - `isWithin()` — Check if a path is within allowed directories

- **`redact.ts`**: Sensitive data redaction
  - `redact()` — Redact sensitive patterns from strings
  - `REDACTION_PATTERNS` — Regex patterns for credentials, tokens, etc.
  - `maskTail()` — Mask a value showing first/last 4 chars

#### `auth/` — Credential Management

- **`store.ts`**: Credential store interface
  - `CredentialStore` — Interface for credential storage
  - `resolveApiKey()` — Resolve API key from environment or store
  - `EnvCredentialStore` — Environment-based credential store

#### `util/` — Utilities

- **`logger.ts`**: Structured logging
  - `Logger` class with levels (debug, info, warn, error)
  - `redact` integration for sensitive data
  - `memorySink()` — In-memory log sink for tests

- **`async.ts`**: Async utilities
  - `Semaphore` — Concurrency control primitive
  - `withTimeout()` — Add timeout to a promise
  - `retry()` — Retry a function with backoff

- **`errors.ts`**: Error types
  - `FreecodeError` — Base error class
  - `ConfigError`, `AuthError`, `NetworkError`, etc.
  - `ExitCode` — Standard exit codes

---

## CLI Package (`@freecode/cli`)

The CLI provides the command-line interface for FreeCode.

### Key Modules

#### `commands/` — CLI Commands

- **`run.ts`**: The main coding agent command
  - Parses prompt and options
  - Creates and runs the agent
  - Handles tool approval and execution

- **`config.ts`**: Configuration management
  - `config show` — Show current configuration (redacted)
  - `config set` — Set configuration values
  - `config get` — Get specific configuration values

- **`doctor.ts`**: Environment diagnosis
  - Checks Node.js version
  - Validates configuration
  - Tests provider connectivity

#### `agent/` — Agent Kernel

The agent kernel implements the coding agent's core logic:

- **`kernel.ts`**: Main agent class
  - Manages agent state (budget, checkpoints, tool results)
  - Coordinates the agent loop

- **`budget.ts`**: Token budget management
  - Tracks input and output token usage
  - Enforces budget limits
  - Reports budget status

- **`approval.ts`**: Tool approval system
  - `Approver` interface for tool approval
  - `InteractiveApprover` — Prompts user for approval
  - `NonInteractiveApprover` — Auto-approves or refuses based on policy

- **`checkpoints.ts`**: Checkpoint management
  - Captures intermediate agent state
  - Allows resuming from checkpoints

- **`loop.ts`**: Agent execution loop
  - Runs the LLM with the current state
  - Processes tool calls
  - Handles errors and retries

#### `tools/` — Tool Implementations

Each tool implements the `Tool` interface:

```typescript
interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  execute(params: unknown, context: ToolContext): Promise<ToolResult>;
}
```

- **`bash.ts`**: Shell command execution
  - Validates commands with `CommandPolicy`
  - Executes in child process with scrubbed environment
  - Returns stdout, stderr, exit code

- **`read.ts`**: File reading
  - Validates paths with `PathGuard`
  - Supports text and binary files
  - Returns file contents

- **`write.ts`**: File writing
  - Validates paths with `PathGuard`
  - Creates directories as needed
  - Prevents overwriting without confirmation

- **`edit.ts`**: File editing
  - Validates paths with `PathGuard`
  - Performs in-place modifications
  - Supports regex and line-based edits

- **`web-fetch.ts`**: Web content fetching
  - Fetches URLs through `SsrfGuard`
  - Returns text content
  - Respects robots.txt and rate limits

- **`web-search.ts`**: Web search
  - Uses search engines to find information
  - Returns search results
  - Respects search engine terms

- **`artifact.ts`**: Artifact management
  - Creates and manages artifacts (files, documents)
  - Supports publishing and sharing

---

## Gateway Package (`@freecode/gateway`)

The gateway provides a hosted server that exposes an OpenAI-compatible API with
additional FreeCode-specific features.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Fastify Server                           │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Routes:                                                   │ │
│  │    POST /v1/chat/completions  ← Main chat endpoint        │ │
│  │    GET  /v1/models            ← List available models       │ │
│  │    GET  /v1/models/:id        ← Get model details          │ │
│  │    GET  /v1/usage             ← Get usage summary          │ │
│  │    GET  /health               ← Health check               │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ uses
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Route Dependencies                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  authenticator: Authenticator    ← SHA-256 API key auth     │ │
│  │  catalogue: Catalogue           ← Model registry           │ │
│  │  resolver: ProviderResolver     ← Provider factory          │ │
│  │  limiter: QuotaLimiter          ← Quota enforcement         │ │
│  │  store: UsageStore              ← Usage ledger              │ │
│  │  log: Logger                   ← Structured logging         │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│   Authenticator      │ │    Catalogue         │ │   ProviderResolver   │
│  - SHA-256 hash      │ │  - Model entries     │ │  - Provider cache    │
│  - Timing-safe cmp   │ │  - Resolve models    │ │  - Warm-up           │
│  - Principal cache   │ │  - Default model     │ │  - Health checks     │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘
                              │
                              │ uses
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Quota & Usage                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  QuotaLimiter:                                               │ │
│  │    - Rolling windows (1min, 24h)                           │ │
│  │    - Semaphore for concurrency                            │ │
│  │    - Request and token limits                              │ │
│  │                                                             │ │
│  │  UsageStore (Memory/Postgres):                              │ │
│  │    - Record usage after each request                       │ │
│  │    - Aggregate usage by principal                          │ │
│  │    - Rolling window queries                                │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Key Modules

#### `config.ts` — Gateway Configuration

Parses environment variables into `GatewayConfig`:

```typescript
interface GatewayConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  logFormat: 'text' | 'json';
  trustProxy: boolean;
  bodyLimitBytes: number;
  upstreamTimeoutMs: number;
  database: DatabaseConfig;
  quota: QuotaLimits;
  apiKeys: string[];
  providers: Record<string, ProviderConfig>;
  defaultModel?: string;
  defaultProvider?: string;
  enforcePaidModels: boolean;
}
```

#### `server/` — HTTP Server

- **`app.ts`**: Fastify application setup
  - Request ID header injection
  - Error handling with `handleFailure`
  - Route registration
  - Streaming response handling

- **`auth.ts`**: Authentication
  - `Principal` type with hashed ID
  - `Authenticator` class for API key validation
  - SHA-256 hashing with timing-safe comparison
  - Bearer header and `x-api-key` header support

- **`deps.ts`**: Route dependencies
  - `RouteDeps` type containing all route dependencies
  - `finishReasonOf()` — Map stop reasons to OpenAI format
  - `costOf()` — Calculate cost from token usage

- **`errors.ts`**: Error handling
  - `GatewayHttpError` — HTTP error with proper status codes
  - Error factories: `badRequest`, `unauthorized`, `notFound`, etc.
  - `upstreamError()` — Wrap upstream errors with redaction
  - `quotaError()` — Map quota errors to proper HTTP errors

- **`wire.ts`**: Wire format utilities
  - Zod schemas for request/response validation
  - `normalizeChatRequest()` — Convert wire format to core types
  - `toCoreMessage()` — Convert wire messages to core messages
  - SSE frame builders: `chunkRole`, `chunkText`, `chunkFinish`, etc.

- **`routes/`**: Route handlers
  - `chat.ts` — `/v1/chat/completions` (streaming and non-streaming)
  - `models.ts` — `/v1/models` and `/v1/models/:id`
  - `usage.ts` — `/v1/usage`

#### `quota/limiter.ts` — Quota Enforcement

- **Rolling windows**: 1-minute and 24-hour windows for requests and tokens
- **Semaphore**: Concurrency control with configurable slot count
- **Check-then-act**: Quota is checked before acquiring a slot
- **Usage recording**: Usage is recorded after the request completes

#### `store/` — Usage Ledger

- **`types.ts`**: Store interface and types
  - `UsageRecord` — Individual usage record
  - `UsageAggregate` — Aggregated usage data
  - `UsageStore` — Interface for usage storage

- **`memory.ts`**: In-memory store
  - `MemoryUsageStore` — In-memory implementation for testing/development
  - Configurable max records with LRU eviction

- **`postgres.ts`**: Postgres store
  - `PostgresUsageStore` — Postgres implementation for production
  - Uses connection pooling
  - Parameterized queries to prevent SQL injection

#### `upstream/` — Provider Management

- **`catalogue.ts`**: Model catalogue
  - `CatalogueEntry` — Model information with billing tier
  - `Catalogue` — Registry of available models
  - `buildCatalogue()` — Build catalogue from provider configs
  - `effectiveBilling()` — Determine billing tier (free/paid)

- **`resolver.ts`**: Provider resolver
  - `ProviderResolver` — Resolves provider IDs to provider instances
  - Caching with failure tracking
  - Warm-up on startup
  - Health checks

---

## Data Flow

### CLI Flow (BYOK Mode)

```
User Input
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  CLI Command Parsing (commands/run.ts)                          │
│  - Parse prompt and options                                     │
│  - Load configuration                                          │
│  - Resolve provider and model                                   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent Creation (agent/kernel.ts)                              │
│  - Create agent with budget, approval, checkpoints              │
│  - Load available tools                                         │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent Loop (agent/loop.ts)                                     │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  1. Build prompt from current state                        │ │
│  │  2. Send to provider via adapter                           │ │
│  │  3. Process LLM response                                   │ │
│  │  4. If tool calls:                                         │ │
│  │     a. Validate with CommandPolicy                        │ │
│  │     b. Request approval if needed                         │ │
│  │     c. Execute tool                                       │ │
│  │     d. Update state with results                          │ │
│  │  5. Check budget and limits                                │ │
│  │  6. Repeat or return final answer                         │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Provider Adapter (providers/http.ts, anthropic.ts, etc.)       │
│  - Convert request to provider format                           │
│  - Send HTTP request with credentials in headers                 │
│  - Process response                                            │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Output to User
```

### Gateway Flow

```
HTTP Request
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Fastify Middleware (server/app.ts)                             │
│  - Inject request ID header                                     │
│  - Parse request body                                          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Authentication (server/auth.ts)                                │
│  - Extract API key from Authorization or x-api-key header        │
│  - SHA-256 hash and compare with configured keys                │
│  - Return Principal if valid                                   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Route Handler (routes/chat.ts)                                │
│  1. Authorize:                                                │
│     - Validate request body with Zod                          │
│     - Resolve model from catalogue                             │
│     - Check if model is allowed (free vs paid)                  │
│  2. Quota Check:                                              │
│     - Check rolling windows (1min, 24h)                         │
│     - Return 429 if quota exceeded                             │
│  3. Resolve Upstream:                                         │
│     - Get provider from resolver                               │
│     - Return 502 if provider unavailable                       │
│  4. Acquire Slot:                                             │
│     - Semaphore hold for concurrency control                   │
│  5. Process Request:                                          │
│     - For streaming: transform events to SSE                   │
│     - For non-streaming: await response                       │
│  6. Record Usage:                                            │
│     - Always in finally block                                  │
│     - Mark with 499 if client disconnected                    │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Provider Adapter (via resolver)                               │
│  - Same adapters as CLI (from @freecode/core)                   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
HTTP Response (SSE or JSON)
```

---

## Key Design Decisions

### 1. OpenAI-Compatible Gateway

The gateway exposes an OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`)
because:

- **Existing clients work:** Any OpenAI client can point to the gateway
- **No new client code:** The CLI uses its existing `openai-compatible` adapter
- **Familiar API:** Users don't need to learn a new API shape
- **Complete access modes:** All three modes (BYOK, free-provider, gateway) are complete

### 2. Check-Then-Act Quota

The quota limiter uses check-then-act:

1. Check quota **before** acquiring a concurrency slot
2. Acquire slot **before** contacting upstream
3. Record usage **after** the request completes

This ensures:

- No wasted slots on quota-exceeded requests
- No upstream contact before quota is confirmed
- Usage is always recorded (even on failures)

The concurrency semaphore covers the gap between check and slot acquisition.

### 3. Server-Side Usage Recording

Usage is recorded **by the server** after the request completes:

- The gateway decides what a principal may consume
- Token counts come from the provider's response (or zeros if unreported)
- Never guesses or estimates token counts
- Partial usage is recorded with status 499 on client disconnect

### 4. Inline-Only Images

Image URLs in prompts must be inline `data:` URLs:

- Prevents SSRF attacks where the gateway fetches attacker-controlled URLs
- The gateway's network position is protected
- Clients must encode images as `data:` URLs before sending

### 5. Redacted Errors

All error messages are redacted:

- Upstream error text may contain sensitive data (requests, credentials)
- The gateway redacts before returning to the client
- Error format is consistent (OpenAI-compatible)
- Status codes distinguish error types for client retry logic

### 6. SHA-256 API Keys

API keys are:

- SHA-256 hashed before storage
- Compared using `timingSafeEqual` to prevent timing attacks
- Stored as `key:<sha256-prefix>` principal IDs
- Never logged or returned in error messages

### 7. Rolling Window Quota

Quota uses rolling windows (not fixed windows):

- **1-minute window:** Rate limiting for burst protection
- **24-hour window:** Daily quota for cost control
- **Rolling calculation:** Counts usage from the last N milliseconds
- **Efficient:** Uses ledger with timestamp indexing

### 8. Semaphore Concurrency

Concurrency is controlled with a Semaphore:

- Configurable maximum concurrent requests
- Slots are held for the entire request (including streaming)
- Prevents resource exhaustion
- Client disconnect releases the slot

---

## Type Safety

FreeCode uses strict TypeScript configuration:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "verbatimModuleSyntax": true
  }
}
```

**Key implications:**

- All optional properties must be explicitly marked with `?` or `undefined`
- No implicit `any` — all types must be explicit
- No unchecked indexed access — `array[0]` requires type guard
- Exact optional property types — `undefined` is distinct from missing
- No property access from index signatures without type guards

---

## Performance Considerations

### Gateway Performance

- **Fastify:** High-performance HTTP server
- **Connection pooling:** Postgres store uses `pg` pool
- **Caching:** Provider resolver caches provider instances
- **Streaming:** Manual SSE handling prevents buffering
- **No blocking:** All I/O is async/await

### Memory Usage

- **Memory store:** Configurable max records with LRU eviction
- **Streaming:** No buffering of response bodies
- **Caching:** Bounded caches (principal cache, provider cache)
- **No leaks:** Usage records are append-only and bounded

---

## Extensibility

### Adding a New Provider

1. Create a new adapter in `packages/core/src/providers/`:

```typescript
// packages/core/src/providers/my-provider.ts
import type { Provider, ProviderInfo, ChatRequest, ChatResponse } from '../types.js';

export const MyProviderInfo: ProviderInfo = {
  id: 'my-provider',
  name: 'My Provider',
  defaultBaseUrl: 'https://api.my-provider.com/v1',
  apiKeyEnvVars: ['MY_PROVIDER_API_KEY'],
  requiresApiKey: true,
};

export class MyProvider implements Provider {
  readonly info = MyProviderInfo;
  readonly baseUrl: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    // store apiKey
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // implement
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // implement
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    // implement
  }

  async checkHealth(): Promise<ProviderHealth> {
    // implement
  }
}
```

2. Register the adapter in `packages/core/src/providers/registry.ts`:

```typescript
// Add to BUILT_IN_PROVIDERS
const BUILT_IN_PROVIDERS: Record<string, ProviderConfig> = {
  // ... existing
  'my-provider': {
    enabled: true,
    type: 'my-provider',
    baseUrl: 'https://api.my-provider.com/v1',
    models: ['model-1', 'model-2'],
    apiKeyEnv: 'MY_PROVIDER_API_KEY',
    requireApproval: false,
    billing: 'unknown',
  },
};

// Add to ADAPTER_TYPES
const ADAPTER_TYPES = ['openai-compatible', 'anthropic', 'google', 'ollama', 'my-provider'];

// Add to adapterFor
if (type === 'my-provider') {
  return MyProvider;
}
```

### Adding a New Tool

1. Create a new tool in `packages/cli/src/tools/`:

```typescript
// packages/cli/src/tools/my-tool.ts
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../agent/types.js';

export const myTool: Tool = {
  name: 'myTool',
  description: 'Does something useful',
  schema: z.object({
    param1: z.string().describe('First parameter'),
    param2: z.number().optional().describe('Optional second parameter'),
  }),
  async execute(params, context): Promise<ToolResult> {
    // implement
    return { success: true, content: 'result' };
  },
};
```

2. Register the tool in `packages/cli/src/agent/tools.ts`:

```typescript
import { myTool } from './tools/my-tool.js';

export const BUILT_IN_TOOLS: Tool[] = [
  // ... existing tools
  myTool,
];
```

---

## See Also

- [Security](security.md) — Security constraints and threat model
- [Testing](testing.md) — Testing strategy and coverage
- [README](../README.md) — Main documentation
