/**
 * Secret redaction.
 *
 * Every string that leaves FreeCode — log lines, `doctor` output, `config show`,
 * error messages, crash reports, audit events — passes through here. Two
 * independent mechanisms are used because either alone is insufficient:
 *
 *   1. **Registered secrets.** Values the process knows are secret (API keys
 *      loaded from the credential store or environment) are registered by value
 *      and replaced wherever they appear, including inside URLs, headers and
 *      base64 payloads. Exact-match redaction is reliable but only covers
 *      secrets we have seen.
 *
 *   2. **Pattern matching.** Shapes that look like credentials (`sk-...`,
 *      `Bearer ...`, PEM blocks, `postgres://user:pass@host`, AWS keys, JWTs,
 *      connection strings). This catches secrets that were never registered —
 *      for example a key pasted into a prompt or echoed back by a provider.
 *
 * Design constraints:
 *   - Redaction must be cheap; it runs on every log line.
 *   - It must not throw on adversarial input (huge strings, weird types).
 *   - Pattern rules must not over-match ordinary source code, or the agent's own
 *     diffs become unreadable. Rules are therefore anchored on known prefixes and
 *     minimum lengths rather than generic "long random string" heuristics.
 */

/** Replacement text. Kept short and greppable so it is obvious in output. */
export const REDACTED = '[REDACTED]';

/** Prefix used when a value must stay partially identifiable, e.g. `sk-ab…7f2c`. */
export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible * 2) return REDACTED;
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}

interface PatternRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

/**
 * Order matters: the first rule that matches a span wins because rules are
 * applied sequentially over the whole string. More specific rules come first.
 */
const PATTERN_RULES: readonly PatternRule[] = [
  {
    // PEM private keys: RSA/EC/OPENSSH/PGP, plus the generic "PRIVATE KEY" form.
    name: 'pem-private-key',
    pattern:
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  },
  {
    // URI userinfo credentials: postgres://user:secret@host, redis://:pw@host ...
    // Applied before provider-key rules so the password position is caught even
    // when it does not look like a known key format.
    name: 'uri-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
  },
  {
    // Authorization headers, including inside serialized objects.
    name: 'authorization-header',
    pattern:
      /\b(authorization|proxy-authorization|x-api-key|api[-_]?key)\b(\s*[:=]\s*)("?)([^\s'"]{8,})\3/gi,
    replace: (_m, field: string, sep: string, quote: string) =>
      `${field}${sep}${quote}${REDACTED}${quote}`,
  },
  {
    name: 'bearer-token',
    pattern: /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,})/g,
    replace: (_m, scheme: string) => `${scheme} ${REDACTED}`,
  },
  {
    // OpenAI / Anthropic / OpenRouter style: sk-..., sk-ant-..., sk-or-v1-...
    name: 'sk-key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replace: (m) => `${m.slice(0, 3)}-${REDACTED}`,
  },
  {
    // Google API keys.
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => `AIza${REDACTED}`,
  },
  {
    // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    replace: () => `gh_${REDACTED}`,
  },
  {
    // AWS access key id (the secret access key has no distinguishing prefix and
    // is caught by the registered-secret mechanism instead).
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: (m) => `${m.slice(0, 4)}${REDACTED}`,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => `xox-${REDACTED}`,
  },
  {
    // JSON Web Tokens: three base64url segments, first decodes to {"alg":...
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => `eyJ${REDACTED}`,
  },
  {
    // Hugging Face tokens.
    name: 'huggingface-token',
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
    replace: () => `hf_${REDACTED}`,
  },
  {
    // Replicate / Together / Groq style long hex or base64url API keys are
    // deliberately NOT matched generically — it produces false positives on
    // hashes in source code. They are covered by registered-secret redaction.
    name: 'basic-auth-url',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9+/=]{16,})@/gi,
    replace: (_m, scheme: string) => `${scheme}${REDACTED}@`,
  },
];

/**
 * Registry of exact secret values.
 *
 * Held in a module-level structure rather than passed around so that redaction
 * applies uniformly even in code paths that never received the config object
 * (third-party stack traces, `unhandledRejection` handlers).
 */
const registered = new Set<string>();

/**
 * Register a secret value for exact-match redaction.
 *
 * Ignores values that are too short to be meaningful (< 8 chars) because
 * replacing them would corrupt ordinary text (e.g. a key of "test").
 * Returns an unregister function for tests and for credential rotation.
 */
export function registerSecret(value: string | undefined | null): () => void {
  if (typeof value !== 'string') return () => {};
  const trimmed = value.trim();
  if (trimmed.length < 8) return () => {};
  registered.add(trimmed);
  return () => {
    registered.delete(trimmed);
  };
}

/** Register many secrets at once. Returns a function that clears all of them. */
export function registerSecrets(values: Iterable<string | undefined | null>): () => void {
  const undo: Array<() => void> = [];
  for (const value of values) undo.push(registerSecret(value));
  return () => {
    for (const fn of undo) fn();
  };
}

/** Remove every registered secret. Intended for tests. */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

/** Number of currently registered secrets. Intended for tests and `doctor`. */
export function registeredSecretCount(): number {
  return registered.size;
}

/**
 * Replace every registered secret appearing in `input` with the redaction marker.
 *
 * The encoded and base64 variants are checked **independently** of the raw form.
 * An earlier version gated all three behind a single `output.includes(secret)`
 * test, which meant a secret that appeared only in URL-encoded form — exactly the
 * case of a key passed as a query parameter — was never redacted. Each variant
 * now gets its own containment check.
 */
function redactRegistered(input: string): string {
  if (registered.size === 0) return input;
  let output = input;
  for (const secret of registered) {
    // Raw form.
    if (output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }

    // URL-encoded form: how a key survives into a query string.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret && output.includes(encoded)) {
      output = output.split(encoded).join(REDACTED);
    }

    // Component-encoded form: spaces as `+`, which `encodeURIComponent` never
    // produces but form-encoded bodies and some clients do.
    const formEncoded = encoded.replace(/%20/g, '+');
    if (formEncoded !== encoded && output.includes(formEncoded)) {
      output = output.split(formEncoded).join(REDACTED);
    }

    // Base64 form: how a key survives into a serialized header or JSON blob.
    const b64 = safeBase64(secret);
    if (b64 !== undefined && b64.length >= 8 && output.includes(b64)) {
      output = output.split(b64).join(REDACTED);
    }
  }
  return output;
}

function safeBase64(value: string): string | undefined {
  try {
    return Buffer.from(value, 'utf8').toString('base64');
  } catch {
    return undefined;
  }
}

/** Apply pattern-based redaction rules. */
export function redactPatterns(input: string): string {
  let output = input;
  for (const rule of PATTERN_RULES) {
    // `lastIndex` is reset by `String.replace` with a /g regex, but a shared
    // regex literal retains state if used with `.test()`. Only `.replace()` is
    // used here, so the rule objects stay safe to share.
    output = output.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: string[]) => string,
    );
  }
  return output;
}

/** Full redaction: exact registered secrets first, then pattern rules. */
export function redact(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  return redactPatterns(redactRegistered(input));
}

/**
 * Deep-redact a JSON-like value.
 *
 * Key names that conventionally hold secrets are replaced wholesale regardless
 * of value, which catches short tokens the length heuristic would skip. Cycles
 * are handled defensively (values returned by providers are untrusted).
 */
export function redactValue<T>(value: T, seen = new WeakSet<object>()): T {
  return redactUnknown(value, seen) as T;
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, seen));
  }

  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      code: (value as NodeJS.ErrnoException).code,
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactUnknown(item, seen);
  }
  return out;
}

/**
 * Field names whose values are treated as secret regardless of shape.
 *
 * Intentionally broad: a false positive costs a developer one puzzled glance at
 * a redacted log line, a false negative leaks a production credential.
 */
const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|apikey|secret|token|password|passwd|credential|authorization|auth[_-]?token|access[_-]?key|private[_-]?key|session[_-]?id|client[_-]?secret|refresh[_-]?token)(?:$|[_-])/i;

/** True when a field name should always be redacted. Exported for tests. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || /^(?:key|token|secret|password)$/i.test(key);
}

/**
 * Detect whether a string *contains* anything that looks like a credential.
 *
 * Used by the security policy to refuse writing secrets into logs or committing
 * them, and by tests asserting that a redaction rule fires. Returns the rule
 * names that matched, which is more useful for debugging than a boolean.
 */
export function detectSecrets(input: string): readonly string[] {
  const hits: string[] = [];
  for (const rule of PATTERN_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (re.test(input)) hits.push(rule.name);
  }
  for (const secret of registered) {
    if (input.includes(secret)) hits.push('registered-secret');
  }
  return hits;
}
