/**
 * Environment parsing.
 *
 * These are pure functions of an env object, so they are asserted directly — no
 * server, no store. The cases that matter are the ones a deployment gets wrong:
 * a malformed JSON list, an out-of-range integer, and a provider entry the
 * gateway must refuse (`gateway`/`custom` would recurse; a bad shape must fail at
 * boot rather than at the first request).
 */

import { describe, expect, it } from 'vitest';

import { ConfigError } from '@freecode/core';

import { parseGatewayConfig, UPSTREAM_TYPES } from '../src/config.js';

const MINIMAL = {
  GATEWAY_API_KEYS: 'k1',
  GATEWAY_PROVIDERS: JSON.stringify({ fake: { models: ['m'], billing: 'free' } }),
};

describe('parseGatewayConfig', () => {
  it('applies documented defaults for an otherwise empty environment', () => {
    const config = parseGatewayConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.logLevel).toBe('info');
    expect(config.bodyLimitBytes).toBe(4 * 1024 * 1024);
    expect(config.quota.requestsPerMinute).toBe(60);
    expect(config.quota.requestsPerDay).toBe(2_000);
    expect(config.enforcePaidModels).toBe(false);
    expect(config.database.enabled).toBe(false);
    expect(config.apiKeys).toEqual([]);
    expect(config.providers).toEqual({});
  });

  it('parses a full environment', () => {
    const config = parseGatewayConfig({
      ...MINIMAL,
      GATEWAY_PORT: '9000',
      GATEWAY_HOST: '0.0.0.0',
      GATEWAY_LOG_LEVEL: 'debug',
      GATEWAY_LOG_FORMAT: 'json',
      GATEWAY_TRUST_PROXY: 'true',
      GATEWAY_REQUESTS_PER_MINUTE: '120',
      GATEWAY_ALLOW_PAID_MODELS: '1',
      GATEWAY_DATABASE_URL: 'postgres://localhost/freecode',
      GATEWAY_DEFAULT_PROVIDER: 'fake',
    });
    expect(config.port).toBe(9000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('debug');
    expect(config.logFormat).toBe('json');
    expect(config.trustProxy).toBe(true);
    expect(config.quota.requestsPerMinute).toBe(120);
    expect(config.enforcePaidModels).toBe(true);
    expect(config.database.enabled).toBe(true);
    expect(config.defaultProvider).toBe('fake');
  });

  it('splits, trims and de-duplicates the API-key list', () => {
    const config = parseGatewayConfig({ GATEWAY_API_KEYS: ' a , b ,a, ' });
    expect(config.apiKeys).toEqual(['a', 'b']);
  });

  it('rejects a non-integer and an out-of-range integer', () => {
    expect(() => parseGatewayConfig({ GATEWAY_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => parseGatewayConfig({ GATEWAY_PORT: '70000' })).toThrow(ConfigError);
    expect(() => parseGatewayConfig({ GATEWAY_REQUESTS_PER_MINUTE: '0' })).toThrow(ConfigError);
  });

  it('rejects a non-boolean flag', () => {
    expect(() => parseGatewayConfig({ GATEWAY_ALLOW_PAID_MODELS: 'maybe' })).toThrow(ConfigError);
  });

  it('rejects an unknown log level', () => {
    expect(() => parseGatewayConfig({ GATEWAY_LOG_LEVEL: 'chatty' })).toThrow(ConfigError);
  });

  it('rejects malformed provider JSON', () => {
    expect(() => parseGatewayConfig({ GATEWAY_PROVIDERS: 'not json' })).toThrow(ConfigError);
  });

  it('rejects a provider entry with an unusable type', () => {
    expect(() =>
      parseGatewayConfig({
        GATEWAY_PROVIDERS: JSON.stringify({ gw: { models: ['m'], type: 'gateway' } }),
      }),
    ).toThrow(ConfigError);
    expect(UPSTREAM_TYPES).not.toContain('gateway');
  });

  it('drops a disabled provider entry rather than failing', () => {
    const config = parseGatewayConfig({
      GATEWAY_PROVIDERS: JSON.stringify({
        on: { models: ['m'] },
        off: { models: ['x'], enabled: false },
      }),
    });
    expect(Object.keys(config.providers)).toEqual(['on']);
  });

  it('parses the price table and rejects a bad entry', () => {
    const config = parseGatewayConfig({
      ...MINIMAL,
      GATEWAY_PRICING: JSON.stringify({ m: { inputPer1M: 3, outputPer1M: 15 } }),
    });
    expect(config.pricing['m']).toEqual({ inputPer1M: 3, outputPer1M: 15 });

    expect(() =>
      parseGatewayConfig({
        ...MINIMAL,
        GATEWAY_PRICING: JSON.stringify({ m: { inputPer1M: -1, outputPer1M: 0 } }),
      }),
    ).toThrow(ConfigError);
  });

  it('defaults the default provider to the first configured one', () => {
    const config = parseGatewayConfig({
      GATEWAY_PROVIDERS: JSON.stringify({ alpha: { models: ['m'] }, beta: { models: ['m'] } }),
    });
    expect(config.defaultProvider).toBe('alpha');
  });
});
