# Testing

> **Quality is not negotiable.**

FreeCode maintains comprehensive test coverage to ensure correctness, security,
and reliability. This document explains the testing strategy, how to run tests,
and what the different test suites cover.

---

## Test Structure

Tests are organized by package and type:

```
packages/
├── core/
│   └── test/           # Core utilities, security primitives, provider adapters
│
├── cli/
│   └── test/           # CLI commands, config, BYOK mode, e2e agent runs
│
└── gateway/
    └── test/           # Gateway routes, auth, quota, streaming
        ├── helpers/     # Test utilities (harness, stub provider)
        ├── gateway.integration.test.ts  # HTTP-level integration tests
        └── config.test.ts       # Gateway config parsing
```

---

## Test Suites

### Core Tests (`packages/core/test/`)

**Coverage:**

- Security utilities (`redact`, `ssrf-guard`, `path-guard`)
- Provider adapters (Anthropic, Google, Ollama, HTTP)
- Credential store implementations
- Configuration schemas and validation
- Error types and handling

**Key files:**

- `security.test.ts` — Redaction patterns, SSRF guard, path guard
- `providers.test.ts` — Provider adapter behavior
- `config.test.ts` — Configuration parsing and validation
- `auth.test.ts` — Credential resolution and storage

### CLI Tests (`packages/cli/test/`)

**Coverage:**

- Command parsing and validation
- Configuration file handling
- BYOK mode (direct provider access)
- Agent execution (tool use, budget, checkpoints)
- End-to-end agent runs

**Key files:**

- `config.test.ts` — CLI config loading and validation
- `models.test.ts` — Model registry and resolution
- `providers.test.ts` — Provider configuration
- `run-e2e.test.ts` — End-to-end agent execution
- `e2e.test.ts` — Integration tests for CLI workflows
- `doctor.test.ts` — Environment diagnosis
- `auth.test.ts` — Authentication flow

### Gateway Tests (`packages/gateway/test/`)

**Coverage:**

- HTTP routes (`/v1/chat/completions`, `/v1/models`, `/v1/usage`, `/health`)
- Authentication (API key validation, timing-safe comparison)
- Quota enforcement (rolling windows, concurrency control)
- Streaming responses (SSE framing, error handling)
- Usage ledger (recording, aggregation)
- Configuration parsing

**Key files:**

- `gateway.integration.test.ts` — Full HTTP integration tests (27 tests)
- `config.test.ts` — Gateway config parsing (11 tests)
- `helpers/harness.ts` — Test harness with real Fastify server and stub provider
- `helpers/stub-provider.ts` — Scriptable provider for testing

---

## Running Tests

### All Tests

```bash
# Run all tests (default)
npm test

# With coverage report
npm run test:coverage

# Watch mode (re-run on changes)
npm run test:watch
```

### Package-Specific Tests

```bash
# Core package
npx vitest run packages/core/test/

# CLI package
npx vitest run packages/cli/test/

# Gateway package
npm run test:gateway
```

### Specific Files

```bash
# Run a single test file
npx vitest run packages/gateway/test/gateway.integration.test.ts

# Run with coverage for a specific file
npx vitest run --coverage packages/cli/test/run-e2e.test.ts
```

---

## Test Configuration

### Vitest Configuration (`vitest.config.ts`)

```typescript
{
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/gateway/test/**/*.integration.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/*/src/**/*.ts'],
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 60,
        lines: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@freecode/core': './packages/core/src/index.ts',
    },
  },
}
```

### Gateway-Specific Configuration (`vitest.gateway.config.ts`)

The gateway tests use a separate configuration to include the integration tests
that are excluded from the root config:

```typescript
{
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/gateway/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@freecode/core': './packages/core/src/index.ts',
    },
  },
}
```

---

## The Full Gate

FreeCode uses a comprehensive gate that must pass before any change is merged:

```bash
npm run check
```

This runs:

1. **`format:check`** — Prettier formatting validation
2. **`lint`** — ESLint with TypeScript rules
3. **`typecheck`** — TypeScript compilation with all strict options
4. **`build`** — Full build of all packages
5. **`test`** — All Vitest tests

### Fixing Gate Failures

**Format issues:**

```bash
npm run format
```

**Lint issues:**

```bash
npm run lint -- --fix  # Auto-fix where possible
```

**Type issues:**
Fix the TypeScript errors and re-run `npm run typecheck`.

**Build issues:**
Ensure all dependencies are built (`npm run build`).

**Test issues:**
Run specific failing tests with `npx vitest run <path>` to debug.

---

## Test Utilities

### Test Harness (`packages/gateway/test/helpers/harness.ts`)

The gateway integration tests use a real Fastify server with a stub provider:

```typescript
const harness = await startHarness({
  env: { GATEWAY_API_KEYS: 'test-key' },
  provider: new StubProvider({ id: 'fake' }),
  now: () => Date.now(),
});

// harness.app — Fastify instance
// harness.url — Base URL of the running server
// harness.provider — Stub provider (records all requests)
// harness.store — Usage store (memory by default)
// harness.deps — Route dependencies

await postJson(harness.url, '/v1/chat/completions', body, authHeaders());

await harness.close();
```

### Stub Provider (`packages/gateway/test/helpers/stub-provider.ts`)

A scriptable provider that implements the full `Provider` interface:

```typescript
const provider = new StubProvider({
  id: 'fake',
  respond: (request) => ({ ...defaultResponse(request) }),
  stream: (request) => defaultStream(request),
});

// Set custom responders
provider.setResponder((request) => ({ ... }));
provider.setStreamer((request) => textStream(['hello', 'world']));

// Access recorded requests
console.log(provider.requests);
```

### Helper Functions

```typescript
// Authentication headers
authHeaders(key); // => { authorization: 'Bearer <key>', 'content-type': 'application/json' }

// HTTP helpers
postJson(url, path, body, headers); // POST JSON, returns { status, headers, text, json }
getJson(url, path, headers); // GET, returns { status, headers, text, json }

// SSE helpers
readSseFrames(body); // Read SSE frames from a streaming response
```

---

## Test Coverage Thresholds

FreeCode enforces minimum coverage thresholds in CI:

| Metric     | Threshold | Rationale                              |
| ---------- | --------- | -------------------------------------- |
| Statements | 60%       | Core functionality must be tested      |
| Branches   | 55%       | Complex logic paths must be covered    |
| Functions  | 60%       | All public functions should have tests |
| Lines      | 60%       | Overall code coverage                  |

**Note:** Test files themselves (`*.test.ts`) are excluded from coverage calculations.

---

## Writing Good Tests

### Principles

1. **Test behavior, not implementation** — Tests should verify what the code does, not how it does it
2. **Isolate tests** — Each test should be independent of others
3. **Use real dependencies where possible** — The gateway tests use real Fastify, real auth, real quota logic
4. **Mock only at boundaries** — Use stub providers, not mocks of internal functions
5. **Test edge cases** — Empty inputs, invalid inputs, error conditions

### Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('module under test', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('should do something', async () => {
    const result = await doSomething();
    expect(result).toEqual(expected);
  });

  it('should handle errors', async () => {
    await expect(doSomethingInvalid()).rejects.toThrow(ExpectedError);
  });
});
```

### Assertions

- **Status codes:** `expect(response.status).toBe(200)`
- **JSON bodies:** `expect(json).toEqual({ expected: 'value' })`
- **Error formats:** `expect(error).toMatchObject({ type: 'invalid_request_error', code: '...' })`
- **SSE frames:** `expect(frames).toContain('data: {...}')`

---

## Performance Testing

The gateway includes load testing considerations:

- **Concurrency:** Tests verify Semaphore-based slot limiting
- **Streaming:** Tests verify SSE framing under backpressure
- **Quota:** Tests verify rolling window enforcement

For load testing in production, use tools like `autocannon` or `k6`:

```bash
# Example with autocannon
npx autocannon -c 10 -d 60 -m POST -H "Authorization: Bearer key" \
  -H "Content-Type: application/json" -b '{"model":"test","messages":[{"role":"user","content":"hi"}]}' \
  http://localhost:8787/v1/chat/completions
```

---

## CI Testing

The CI pipeline runs:

1. `npm run check` — Full gate
2. `npm run test:coverage` — Tests with coverage thresholds
3. `npm run audit` — Dependency security audit

All must pass for a PR to be merged.

---

## See Also

- [Security](security.md) — Security constraints and threat model
- [Architecture](architecture.md) — System design
- [README](../README.md) — Main documentation
