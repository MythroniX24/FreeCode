# FreeCode

> **A secure, production-ready AI coding CLI with a hosted gateway.**

FreeCode is a TypeScript CLI that lets you run coding agents against your own keys
(BYOK), authorized free-tier providers, or a hosted gateway with server-enforced
quotas. It is built for security, auditability, and correctness:

- **Strict TypeScript**: ESM, NodeNext, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- **Runtime validation**: Zod schemas for all configs, requests, and responses
- **Security-first**: Credentials never touch disk, logs, or argv; SSRF guard; inline-only images; redacted errors
- **Three access modes**: BYOK (your own keys), authorized free providers, hosted gateway
- **Hosted gateway**: Fastify server with SHA-256 API-key auth, rolling-window quota, Semaphore concurrency, Postgres/memory ledger

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Access Modes](#access-modes)
- [CLI Commands](#cli-commands)
- [Hosted Gateway](#hosted-gateway)
- [Security](#security)
- [Testing](#testing)
- [Architecture](#architecture)
- [License](#license)

---

## Install

```bash
# Clone the repository
git clone <repository-url> freecode
cd freecode

# Install dependencies
npm install

# Build all packages
npm run build

# Link the CLI globally (optional)
npx npm link --workspace packages/cli
```

---

## Quick Start

Set your API key as an environment variable (never in config files or command-line args):

```bash
# Anthropic
export ANTHROPIC_API_KEY="sk-..."

# Google
export GOOGLE_AI_API_KEY="AIza..."

# OpenRouter
export OPENROUTER_API_KEY="sk-or-..."
```

Then run the coding agent:

```bash
freecode run "Implement a binary search in TypeScript"
```

---

## Access Modes

### 1. BYOK (Bring Your Own Key)

Use your own provider keys. The CLI reads credentials from environment variables
and routes requests directly to the provider's API.

```bash
freecode run --provider anthropic "Write a test suite"
```

Supported providers: Anthropic, Google, OpenRouter, Groq, Ollama.

### 2. Authorized Free-Provider

Use free-tier providers without managing keys. The CLI uses built-in adapters
for providers with free tiers (Google, Groq, Ollama).

```bash
freecode run --provider google "Explain this code"
```

### 3. Hosted Gateway

Run or connect to a hosted gateway that enforces quotas and provides a single
endpoint for multiple users. The gateway is OpenAI-compatible, so any OpenAI
client can point to it.

```bash
# Start the gateway
freecode gateway:start

# Or use the CLI through the gateway
freecode run --gateway-url http://localhost:8787 --gateway-key your-key "Refactor this module"
```

---

## CLI Commands

| Command                             | Description                              |
| ----------------------------------- | ---------------------------------------- |
| `freecode run <prompt>`             | Run the coding agent with a prompt       |
| `freecode run --provider <name>`    | Use a specific provider                  |
| `freecode run --model <name>`       | Use a specific model                     |
| `freecode run --gateway-url <url>`  | Route through a gateway                  |
| `freecode run --gateway-key <key>`  | API key for the gateway                  |
| `freecode config show`              | Show current configuration (redacted)    |
| `freecode config set <key> <value>` | Set a configuration value                |
| `freecode doctor`                   | Diagnose environment and configuration   |
| `freecode gateway:start`            | Start the hosted gateway                 |
| `freecode gateway:dev`              | Start the gateway in dev mode (with tsx) |

---

## Hosted Gateway

The gateway is a Fastify server that provides:

- **OpenAI-compatible API**: `/v1/chat/completions`, `/v1/models`, `/v1/usage`
- **Authentication**: SHA-256 hashed API keys via `Authorization: Bearer` or `x-api-key`
- **Quota Enforcement**: Rolling 1-minute and 24-hour windows for requests and tokens
- **Concurrency Control**: Semaphore-based slot limiting
- **Usage Ledger**: Postgres or in-memory storage for usage tracking
- **Model Gating**: Block paid models unless explicitly allowed

### Configuration

Set environment variables before starting the gateway:

```bash
# Server settings
export GATEWAY_HOST=127.0.0.1
export GATEWAY_PORT=8787
export GATEWAY_LOG_LEVEL=info

# API keys (comma-separated)
export GATEWAY_API_KEYS="key1,key2,key3"

# Quota limits
export GATEWAY_REQUESTS_PER_MINUTE=60
export GATEWAY_REQUESTS_PER_DAY=2000
export GATEWAY_INPUT_TOKENS_PER_DAY=2000000
export GATEWAY_OUTPUT_TOKENS_PER_DAY=500000

# Concurrency
export GATEWAY_MAX_CONCURRENT_REQUESTS=4

# Providers (JSON)
export GATEWAY_PROVIDERS='{"anthropic":{"enabled":true,"type":"anthropic","models":["claude-3-sonnet-20241022"]}}'

# Allow paid models
export GATEWAY_ALLOW_PAID_MODELS=true

# Database
export DATABASE_URL="postgres://user:pass@localhost:5432/freecode"
```

### Starting the Gateway

```bash
# Production
npm run gateway:start

# Development (with hot reload)
npm run gateway:dev
```

---

## Security

FreeCode enforces strict security constraints. See [docs/security.md](docs/security.md) for details.

**Key principles:**

- Credentials are **never** written to disk, logs, or command-line arguments
- All file operations are confined by `PathGuard`
- Network requests pass through `SsrfGuard` (loopback allowed by default)
- Image URLs must be inline `data:` URLs (no remote fetch)
- Error messages are redacted before returning to clients
- API keys are SHA-256 hashed for storage and comparison

---

## Testing

FreeCode has comprehensive test coverage. See [docs/testing.md](docs/testing.md).

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run gateway-specific tests
npm run test:gateway

# Type-check the entire codebase
npm run typecheck

# Lint
npm run lint

# Full gate (format + lint + typecheck + build + test)
npm run check
```

---

## Architecture

See [docs/architecture.md](docs/architecture.md) for a detailed overview.

### Core Packages

| Package             | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `@freecode/core`    | Shared types, utilities, security primitives, provider adapters |
| `@freecode/cli`     | Command-line interface                                          |
| `@freecode/gateway` | Hosted gateway server                                           |

### Key Components

- **Agent Kernel**: Budget, approval, checkpoints, tool loop
- **Tool Suite**: Bash, Read, Write, Edit, WebFetch, WebSearch, Artifact
- **Provider Adapters**: Anthropic, Google, Ollama, OpenAI-compatible
- **Security**: SSRF guard, path guard, redaction, credential store
- **Gateway**: Fastify routes, auth, quota, usage ledger

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run check` to ensure everything passes
5. Submit a pull request

---

## License

[MIT](LICENSE)
