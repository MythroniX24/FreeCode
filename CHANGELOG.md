# Changelog

All notable changes to FreeCode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- Initial implementation of FreeCode CLI with three access modes:
  - BYOK (Bring Your Own Key)
  - Authorized free-provider access
  - Hosted gateway with server-enforced quotas

- Core package (`@freecode/core`):
  - Strict TypeScript configuration with all `strict` options enabled
  - Security primitives: `SsrfGuard`, `PathGuard`, `redact`
  - Provider adapters: Anthropic, Google, Ollama, HTTP (OpenAI-compatible)
  - Credential store interface with secure implementations
  - Configuration schemas with Zod validation
  - Error types and handling utilities

- CLI package (`@freecode/cli`):
  - `freecode run` command for coding agent execution
  - `freecode config` command for configuration management
  - `freecode doctor` command for environment diagnosis
  - `freecode gateway:start` and `gateway:dev` commands
  - Agent kernel with budget, approval, checkpoints, and tool loop
  - Tool suite: Bash, Read, Write, Edit, WebFetch, WebSearch, Artifact

- Gateway package (`@freecode/gateway`):
  - Fastify server with OpenAI-compatible API
  - SHA-256 API key authentication
  - Rolling-window quota enforcement (1min + 24h)
  - Semaphore-based concurrency control
  - Postgres and memory usage ledger implementations
  - Model gating (paid models blocked by default)
  - Redacted error handling

- Comprehensive test suites:
  - Core tests: Security utilities, provider adapters, config validation
  - CLI tests: Command parsing, BYOK mode, agent execution
  - Gateway tests: HTTP routes, auth, quota, streaming, usage ledger

- Documentation:
  - README.md with installation, usage, and architecture overview
  - docs/security.md with threat model and security constraints
  - docs/testing.md with testing strategy and coverage thresholds

---

## [0.1.0] - 2026-10-11

### Added

- Project scaffolding with TypeScript 5.9.3, ESM, NodeNext
- Package structure with `core`, `cli`, and `gateway` packages
- Project references for composite builds
- Vitest configuration with coverage thresholds
- ESLint configuration with TypeScript rules
- Prettier configuration for consistent formatting
- Build and mirror scripts for cross-device development

---

[Unreleased]: https://github.com/freecode/freecode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/freecode/freecode/releases/tag/v0.1.0
