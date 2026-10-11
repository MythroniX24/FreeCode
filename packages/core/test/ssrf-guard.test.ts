/**
 * SSRF-guard tests.
 *
 * The guard is the boundary between "a user configured a provider endpoint" and
 * "the CLI makes an authenticated request somewhere". Every blocked range below
 * has been a real SSRF payload in the wild; the cloud-metadata entries are the
 * ones that turn a request into a credential theft.
 *
 * DNS is injected rather than performed so the tests do not depend on the
 * resolver, and so a rebinding host can be simulated exactly.
 */

import { describe, expect, it } from 'vitest';

import { PolicyDeniedError, ProviderError } from '../src/errors.js';
import {
  SsrfGuard,
  classifyAddress,
  expandIpv6,
  inCidrV4,
  ipv4ToInt,
  safeUrlForDisplay,
} from '../src/security/ssrf-guard.js';

/** Build a guard whose resolver returns a fixed address set per hostname. */
function guardWith(records: Record<string, string[]>): SsrfGuard {
  return new SsrfGuard({
    resolve: async (hostname) => records[hostname] ?? [],
  });
}

const publicDns = guardWith({
  'api.example.com': ['93.184.216.34'],
  'api.openai.com': ['104.18.6.192', '104.18.7.192'],
});

describe('address classification', () => {
  it('classifies the AWS/GCP/Azure metadata address as blocked', () => {
    const range = classifyAddress('169.254.169.254');
    expect(range?.name).toBe('link-local');
  });

  it('classifies private ranges', () => {
    for (const address of ['10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '100.64.0.1']) {
      expect(classifyAddress(address), address).toBeDefined();
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700::1111']) {
      expect(classifyAddress(address), address).toBeUndefined();
    }
  });

  it('classifies IPv6 loopback, ULA and link-local', () => {
    expect(classifyAddress('::1')?.name).toBe('loopback-v6');
    expect(classifyAddress('fd00::1')?.name).toBe('ula-v6');
    expect(classifyAddress('fe80::1')?.name).toBe('link-local-v6');
  });

  it('classifies the IPv6 cloud metadata endpoint', () => {
    expect(classifyAddress('fd00:ec2::254')?.name).toBe('metadata-aws-v6');
  });

  it('classifies IPv4-mapped IPv6 forms of private addresses', () => {
    // The bypass this guards against: a naive filter checks only the IPv4
    // dotted form and misses `::ffff:127.0.0.1`.
    expect(classifyAddress('::ffff:127.0.0.1')).toBeDefined();
    expect(classifyAddress('::ffff:10.0.0.1')).toBeDefined();
    expect(classifyAddress('::ffff:192.168.0.1')).toBeDefined();
  });

  it('classifies IPv6 transition mechanisms that tunnel to IPv4', () => {
    expect(classifyAddress('2002:7f00:0001::')?.name).toBe('transition-mechanism');
  });

  it('ignores non-addresses', () => {
    expect(classifyAddress('not-an-address')).toBeUndefined();
  });
});

describe('CIDR helpers', () => {
  it('parses and compares IPv4', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295);
    expect(ipv4ToInt('256.0.0.1')).toBeUndefined();
    expect(ipv4ToInt('1.2.3')).toBeUndefined();
    expect(inCidrV4('10.1.2.3', '10.0.0.0', 8)).toBe(true);
    expect(inCidrV4('11.1.2.3', '10.0.0.0', 8)).toBe(false);
  });

  it('expands IPv6 including the compressed and mapped forms', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6('2001:db8::1')?.[0]).toBe(0x2001);
    expect(expandIpv6('fe80::1%eth0')?.[0]).toBe(0xfe80);
    expect(expandIpv6('not:an:address')).toBeUndefined();
  });
});

describe('endpoint validation', () => {
  it('accepts a normal public https endpoint', async () => {
    const result = await publicDns.validate('https://api.example.com/v1');
    expect(result.loopback).toBe(false);
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it('rejects plain http for a public host', async () => {
    await expect(publicDns.validate('http://api.example.com/v1')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('rejects the cloud metadata endpoint configured as a provider', async () => {
    await expect(
      publicDns.validate('http://169.254.169.254/computeMetadata/v1/'),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    const rebinding = guardWith({ 'evil.example.com': ['10.0.0.5'] });
    await expect(rebinding.validate('https://evil.example.com/v1')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('rejects a host with both public and private records', async () => {
    // Rejecting only when *every* address is blocked would let a dual-record
    // host through, and the connection might land on the private one.
    const split = guardWith({ 'split.example.com': ['93.184.216.34', '192.168.1.10'] });
    await expect(split.validate('https://split.example.com/v1')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('refuses URLs containing embedded credentials', async () => {
    await expect(
      publicDns.validate('https://user:secret@api.example.com/v1'),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('rejects a non-http scheme', async () => {
    await expect(publicDns.validate('file:///etc/passwd')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await expect(publicDns.validate('ftp://example.com')).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('rejects a malformed URL', async () => {
    await expect(publicDns.validate('not a url')).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('surfaces a DNS failure as a ProviderError, not a denial', async () => {
    const failing = guardWith({});
    await expect(failing.validate('https://nonexistent.invalid/v1')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('reports an unresolvable host through the injected resolver', async () => {
    const throwing = new SsrfGuard({
      resolve: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });
    await expect(throwing.validate('https://nope.invalid/')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('loopback handling', () => {
  it('permits an explicitly allowed loopback host over http', async () => {
    // Local inference servers (Ollama, llama.cpp, LM Studio) are a legitimate
    // and common BYOK target and speak plain http on localhost.
    const local = new SsrfGuard({
      allowLoopbackHosts: ['localhost'],
      resolve: async () => ['127.0.0.1'],
    });
    const result = await local.validate('http://localhost:11434/v1');
    expect(result.loopback).toBe(true);
  });

  it('refuses a loopback address that is not on the allowlist', async () => {
    const local = new SsrfGuard({ allowLoopbackHosts: [], resolve: async () => [] });
    await expect(local.validate('http://127.0.0.1:11434/v1')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('refuses loopback http when insecure loopback is disabled', async () => {
    const local = new SsrfGuard({
      allowLoopbackHosts: ['localhost'],
      allowInsecureLoopback: false,
      resolve: async () => ['127.0.0.1'],
    });
    await expect(local.validate('http://localhost:11434/v1')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });
});

describe('redirect validation', () => {
  const from = new URL('https://api.example.com/v1');

  it('follows a same-scheme redirect to a public host', async () => {
    const result = await publicDns.validateRedirect(from, 'https://api.openai.com/v1', 1);
    expect(result.addresses.length).toBeGreaterThan(0);
  });

  it('refuses an https to http downgrade', async () => {
    await expect(
      publicDns.validateRedirect(from, 'http://api.example.com/v1', 1),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('refuses a redirect to a private address', async () => {
    const rebinding = guardWith({ 'internal.example.com': ['10.0.0.5'] });
    await expect(
      rebinding.validateRedirect(from, 'https://internal.example.com/', 1),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('refuses a redirect to the metadata endpoint', async () => {
    await expect(
      publicDns.validateRedirect(from, 'http://169.254.169.254/latest/meta-data/', 1),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('resolves a relative redirect against the current URL', async () => {
    const result = await publicDns.validateRedirect(from, '/v2/models', 1);
    expect(result.url.pathname).toBe('/v2/models');
  });
});

describe('safeUrlForDisplay', () => {
  it('strips credentials from a URL', () => {
    expect(safeUrlForDisplay('https://user:pw@api.example.com/v1')).not.toContain('pw');
  });

  it('elides the query string, which often carries a key', () => {
    expect(safeUrlForDisplay('https://api.example.com/v1?key=sk-secret-value')).not.toContain(
      'sk-secret-value',
    );
  });

  it('handles an unparseable value without throwing', () => {
    expect(safeUrlForDisplay('::::')).toBe('[invalid-url]');
  });
});
