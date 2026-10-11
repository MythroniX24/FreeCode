# Security

> **Security is not an afterthought. It is the foundation.**

FreeCode is designed with security as a first-class concern. This document outlines
the threat model, security constraints, and implementation details that keep
users safe when using FreeCode in any of its three access modes.

---

## Threat Model

FreeCode operates in environments where:

1. **Credentials have high value** — API keys for LLMs can incur significant costs if leaked
2. **User input is untrusted** — Prompts, file paths, and URLs come from users who may be malicious or mistaken
3. **Network position matters** — The gateway may have access to internal networks that attackers want to probe
4. **Downstream impact is real** — A compromised agent can delete files, exfiltrate data, or execute arbitrary code

---

## Security Constraints

These constraints are **governing** — they apply to all code in the FreeCode codebase
and must never be violated.

### 1. Credential Handling

**Credential values are NEVER placed in:**

- Command-line arguments (`argv`)
- Configuration files (JSON, YAML, TOML, etc.)
- Log output (stdout, stderr, or any log sink)
- Environment variable names that reveal the value

**Credential storage:**

- Credentials are stored only in environment variables
- API keys are SHA-256 hashed before storage in the gateway's principal cache
- The `CredentialStore` interface explicitly refuses to read or write `.env` files
- Atomic config writes use temp file mode `0600` + rename, with directory mode `0700`

**Credential usage:**

- Credentials are passed in HTTP headers, never in URLs
- The agent's `run_command` runs with a scrubbed child environment (`buildChildEnv`)
- Raw-mode secret prompt is used for TTY credential entry

### 2. Redaction

All potentially sensitive data is redacted before logging or returning to clients:

**Redaction patterns (see `util/redact.ts`):**

- API keys: `sk-[A-Za-z0-9_-]{16,}` (Anthropic, OpenRouter, etc.)
- Google AI keys: `AIza[0-9A-Za-z\-_]{35}`
- GitHub tokens: `ghp_[A-Za-z0-9]{36,}`
- AWS keys: `AKIA[0-9A-Z]{16}`
- Slack tokens: `xox[baprs]-[0-9A-Za-z\-]+`
- Hugging Face tokens: `hf_[A-Za-z0-9]{40}`
- JWT tokens: `eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+`
- URI userinfo (e.g., `user:password@host`)
- Authorization headers (`Bearer`, `Basic`)
- Header names: `authorization`, `x-api-key`, `api-key`, `api_key`

**Redaction in the gateway:**

- Upstream error text is redacted before returning to clients
- The gateway's own errors use redacted messages
- Usage records store only token counts and costs, never prompts or responses

### 3. File System Access

All file operations are confined by `PathGuard`:

- **Allowed operations:** Read, Write, Edit (in-place modification)
- **Path validation:** All paths must be within the working directory or explicitly allowed
- **No symlink following:** Paths are resolved to real paths to prevent symlink escapes
- **No directory traversal:** Paths containing `..` are rejected
- **Tool-specific guards:**
  - `Bash`: Commands are validated; dangerous patterns are blocked
  - `Read`: Paths must be within allowed directories
  - `Write`: Paths must be within allowed directories; no overwriting existing files without confirmation
  - `Edit`: Paths must be within allowed directories

### 4. Network Access

All HTTP requests pass through `SsrfGuard`:

- **Default allowed loopback hosts:** `localhost`, `127.0.0.1`, `[::1]`
- **Blocked by default:** All other internal/private IP ranges
- **Allowlist:** Operators can explicitly allow additional hosts via `allowLoopbackHosts`
- **No remote image fetching:** Image URLs in prompts must be inline `data:` URLs; remote URLs are refused

**SSRF prevention:**

- The gateway never fetches remote URLs on behalf of clients
- Provider adapters only contact their configured endpoints
- The `SsrfGuard` is applied to all outgoing requests

### 5. Input Validation

All external input is validated:

- **Zod schemas:** All configs, requests, and responses use Zod for runtime validation
- **Type safety:** TypeScript with `strict: true`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **Request validation:** The gateway validates all request bodies against OpenAI-compatible schemas
- **Model resolution:** Unknown models are refused with a 404 listing available alternatives

---

## Gateway-Specific Security

### Authentication

- **API key authentication:** SHA-256 hash of the key is stored and compared
- **Timing-safe comparison:** `timingSafeEqual` is used to prevent timing attacks
- **Bearer header preferred:** `Authorization: Bearer <key>` is the primary method
- **Fallback:** `x-api-key` header is also accepted
- **Disabled state:** When no API keys are configured, the gateway logs a loud warning

### Quota Enforcement

- **Rolling windows:** 1-minute and 24-hour windows for requests and tokens
- **Server-side enforcement:** The gateway, not the client, decides what a principal may consume
- **Concurrency control:** Semaphore-based slot limiting prevents resource exhaustion
- **Usage ledger:** All usage is recorded after the fact; unreported usage defaults to zeros

### Error Handling

- **No stack traces:** Error responses never include stack traces
- **Redacted messages:** Upstream error text is redacted before returning
- **Consistent error format:** All errors follow the OpenAI-compatible format with `type`, `code`, and `message`
- **Status codes:** Appropriate HTTP status codes for different error types

---

## Provider Security

### Provider Adapters

Each provider adapter implements the `Provider` interface:

```typescript
interface Provider {
  info: ProviderInfo;
  baseUrl: string;
  listModels(): Promise<ModelDescriptor[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncGenerator<StreamEvent>;
  checkHealth(): Promise<ProviderHealth>;
}
```

**Security considerations:**

- API keys are passed in headers, never in URLs
- Request timeouts are enforced to prevent hanging requests
- Response validation ensures the provider returns expected types
- Error handling redacts sensitive information

### Built-in Providers

| Provider   | Type      | Keys Required | Security Notes               |
| ---------- | --------- | ------------- | ---------------------------- |
| Anthropic  | Native    | Yes           | Uses `x-api-key` header      |
| Google     | Native    | Yes           | Uses `x-api-key` header      |
| Ollama     | Native    | No            | Local inference, no keys     |
| OpenRouter | BYOK      | Yes           | Uses `Authorization: Bearer` |
| Groq       | Free-tier | Yes           | Uses `Authorization: Bearer` |

---

## Agent Security

### Tool Execution

- **PathGuard:** All file operations are validated against allowed paths
- **CommandPolicy:** Bash commands are validated before execution
- **Approval:** Non-interactive approvers must refuse rather than silently allow
- **Budget:** Token budgets prevent runaway generation
- **Checkpoints:** Intermediate state is captured for auditability

### Sandboxing

- **Child environment:** The agent's `run_command` uses `buildChildEnv` to scrub sensitive variables
- **No eval:** `no-eval`, `no-implied-eval`, `no-new-func` lint rules prevent dynamic code execution
- **Isolated workers:** Vitest uses forked workers for test isolation

---

## Security Review Checklist

Before merging any change, verify:

- [ ] No credentials in code, config, or logs
- [ ] All external input is validated (Zod schemas)
- [ ] File operations use `PathGuard`
- [ ] Network requests pass through `SsrfGuard`
- [ ] Error messages are redacted
- [ ] Type safety is maintained (no `any`, proper null checks)
- [ ] New dependencies have been audited (`npm audit`)
- [ ] Tests cover the new functionality
- [ ] Documentation is updated

---

## Reporting Security Issues

If you discover a security vulnerability in FreeCode, please:

1. **Do not** open a public issue
2. **Do** contact the maintainers privately
3. Provide a clear description of the vulnerability
4. Include steps to reproduce
5. Allow reasonable time for a fix before public disclosure

---

## See Also

- [Architecture](architecture.md) — System design and component relationships
- [Testing](testing.md) — Testing strategy and how to run tests
- [README](../README.md) — Main documentation
