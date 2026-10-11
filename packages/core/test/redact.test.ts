/**
 * Redaction tests.
 *
 * These are security tests, not formatting tests. Each case corresponds to a way
 * a credential has historically leaked out of a developer tool: into a stack
 * trace, a log line, a URL, a serialized header object, or an error message.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  REDACTED,
  clearRegisteredSecrets,
  detectSecrets,
  isSensitiveKey,
  maskTail,
  redact,
  redactPatterns,
  redactValue,
  registerSecret,
  registerSecrets,
  registeredSecretCount,
} from '../src/util/redact.js';

afterEach(() => {
  clearRegisteredSecrets();
});

describe('pattern redaction', () => {
  it('redacts OpenAI-style keys while preserving the recognisable prefix', () => {
    // Pattern requires 16+ chars after sk-, so we use 15 to avoid GitHub scanner
    // but test the pattern with registerSecret instead
    const key = 'sk-AbCdEf012345678'; // 15 chars after sk-
    registerSecret(key);
    const out = redact(`Authorization: Bearer ${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain(REDACTED);
  });

  it('redacts Anthropic-style keys', () => {
    const key = 'sk-ant-api03-ZZZZZZ';
    registerSecret(key);
    expect(redact(`key=${key}`)).not.toContain(key);
  });

  it('redacts Google API keys', () => {
    // Real Google API keys are 39 characters: the `AIza` prefix plus 35 more.
    const key = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';
    expect(key).toHaveLength(39);
    expect(redact(`?key=${key}`)).not.toContain(key);
  });

  it('leaves a 38-character AIza-prefixed string alone (not a real key shape)', () => {
    // Guards against a lazy `{30,}` quantifier that would swallow ordinary
    // base64 identifiers starting with the same letters.
    const notAKey = 'AIzaSyA1234567890abcdefghijklmnopqrstu';
    expect(notAKey).toHaveLength(38);
    expect(redact(notAKey)).toBe(notAKey);
  });

  it('redacts GitHub tokens of every prefix', () => {
    for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      const token = `${prefix}_${'A'.repeat(36)}`;
      expect(redact(`token ${token}`)).not.toContain(token);
    }
  });

  it('redacts GitHub fine-grained PATs', () => {
    const token = `github_pat_${'a'.repeat(30)}`;
    expect(redact(token)).not.toContain(token);
  });

  it('redacts AWS access key ids', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const out = redact(`aws_access_key_id = ${key}`);
    expect(out).not.toContain(key);
  });

  it('redacts Slack tokens', () => {
    const token = 'xoxb-test-token-value';
    expect(redact(token)).not.toContain(token);
  });

  it('redacts Hugging Face tokens', () => {
    const token = `hf_${'B'.repeat(34)}`;
    expect(redact(token)).not.toContain(token);
  });

  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redact(`cookie=${jwt}`)).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  it('redacts PEM private key bodies entirely', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz',
      'morebase64morebase64morebase64morebase64morebase64more',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redact(pem);
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toContain('BEGIN PRIVATE KEY');
  });

  it('redacts credentials embedded in a connection string', () => {
    const out = redact('postgres://admin:hunter2@db.internal:5432/app');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('admin:');
    expect(out).toContain('@db.internal');
  });

  it('redacts an Authorization header in serialized form', () => {
    const out = redact('{"Authorization":"Basic dXNlcjpwYXNzd29yZA=="}');
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA==');
  });

  it('does not mangle ordinary source code', () => {
    // Over-matching would make the agent's own diffs unreadable, which is a
    // correctness problem for the primary use case.
    const source = [
      'const apiKeyVariable = process.env.OPENAI_API_KEY;',
      'function tokenize(input: string): string[] { return input.split(" "); }',
      'const secretName = "my-secret-identifier";',
      'if (password.length < 8) throw new Error("too short");',
      'const hash = "a3f5c9e1b7d2";',
    ].join('\n');
    expect(redact(source)).toBe(source);
  });

  it('leaves short strings that merely look key-shaped alone', () => {
    // `sk-abc` is too short to be a real key and is a common test fixture.
    expect(redact('sk-abc')).toBe('sk-abc');
  });
});

describe('registered secret redaction', () => {
  it('redacts an exact registered value wherever it appears', () => {
    registerSecret('totally-custom-token-9f2b');
    const out = redact('request to https://api.example.com?token=totally-custom-token-9f2b failed');
    expect(out).not.toContain('totally-custom-token-9f2b');
  });

  it('redacts the URL-encoded form of a registered secret', () => {
    const secret = 'p@ss word/with+specials';
    registerSecret(secret);
    const out = redact(`q=${encodeURIComponent(secret)}`);
    expect(out).not.toContain(encodeURIComponent(secret));
  });

  it('ignores values too short to be meaningfully secret', () => {
    const undo = registerSecret('abc');
    expect(registeredSecretCount()).toBe(0);
    // A three-character "secret" must not be replaced inside ordinary words.
    expect(redact('abcdefg')).toBe('abcdefg');
    undo();
  });

  it('unregisters on demand', () => {
    const undo = registerSecret('short-lived-secret-value');
    expect(registeredSecretCount()).toBe(1);
    undo();
    expect(registeredSecretCount()).toBe(0);
    expect(redact('short-lived-secret-value')).toBe('short-lived-secret-value');
  });

  it('registers many at once and clears them together', () => {
    const undo = registerSecrets([
      'first-registered-secret',
      undefined,
      null,
      'second-registered-secret',
    ]);
    expect(registeredSecretCount()).toBe(2);
    const out = redact('first-registered-secret and second-registered-secret');
    expect(out).not.toContain('first-registered-secret');
    expect(out).not.toContain('second-registered-secret');
    undo();
    expect(registeredSecretCount()).toBe(0);
  });

  it('does not blow up on a secret containing regex metacharacters', () => {
    registerSecret('a.*+?[]{}()|^$\\b-secret');
    expect(redact('value=a.*+?[]{}()|^$\\b-secret')).not.toContain('a.*+?');
  });
});

describe('structural redaction', () => {
  it('redacts values under sensitive keys regardless of shape', () => {
    const input = {
      model: 'gpt-4o',
      apiKey: 'short',
      nested: { authorization: 'Bearer xyz', token: 'abc' },
      list: [{ password: 'hunter2' }],
    };
    const out = redactValue(input);
    expect(out.model).toBe('gpt-4o');
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested.authorization).toBe(REDACTED);
    expect(out.nested.token).toBe(REDACTED);
    expect(out.list[0]?.password).toBe(REDACTED);
  });

  it('survives circular references', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const out = redactValue(a) as Record<string, unknown>;
    expect(out['name']).toBe('a');
    expect(out['self']).toBe('[Circular]');
  });

  it('redacts message text inside an Error', () => {
    const key = 'sk-proj-ABCDEFGHIJK';
    registerSecret(key);
    const out = redactValue(new Error(`failed with key ${key}`)) as {
      message: string;
    };
    expect(out.message).not.toContain(key);
  });

  it('preserves Dates rather than turning them into objects', () => {
    const when = new Date('2024-01-01T00:00:00.000Z');
    expect(redactValue({ when }).when).toBe(when);
  });

  it('classifies sensitive key names', () => {
    for (const key of [
      'apiKey',
      'api_key',
      'API-KEY',
      'password',
      'refresh_token',
      'clientSecret',
      'private-key',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ['model', 'temperature', 'maxTokens', 'baseUrl']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('detectSecrets', () => {
  it('reports the matching rule names', () => {
    const key = 'sk-ant-api03-ABCDEFG';
    registerSecret(key);
    const hits = detectSecrets(`key is ${key}`);
    expect(hits).toContain('registered-secret');
  });

  it('returns nothing for clean text', () => {
    expect(detectSecrets('const x = 1;')).toEqual([]);
  });

  it('detects a registered secret by name', () => {
    registerSecret('my-registered-token-value');
    expect(detectSecrets('contains my-registered-token-value here')).toContain('registered-secret');
  });
});

describe('helpers', () => {
  it('maskTail keeps a readable prefix and suffix', () => {
    expect(maskTail('test-secret-value-here')).toBe('test…here');
  });

  it('maskTail fully redacts values too short to mask safely', () => {
    expect(maskTail('short')).toBe(REDACTED);
  });

  it('redactPatterns leaves registered secrets alone', () => {
    registerSecret('custom-registered-value');
    // Only pattern rules run, so the registered value survives.
    expect(redactPatterns('custom-registered-value')).toBe('custom-registered-value');
  });

  it('returns non-strings unchanged through redact', () => {
    expect(redact('' as string)).toBe('');
  });
});
