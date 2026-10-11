/**
 * Endpoint validation and SSRF defence.
 *
 * Users may configure custom provider endpoints (`providers.<id>.baseUrl`), and
 * the hosted-gateway client follows redirects. Both are attacker-influenced
 * inputs: a malicious or mistyped base URL could point the CLI at
 * `http://169.254.169.254/computeMetadata/v1/` and turn a "free AI model" into a
 * credential-exfiltration primitive against the user's own machine.
 *
 * Defences, in order of application:
 *
 *  1. **Scheme allowlist** — `https` only, except for explicitly-permitted
 *     loopback development endpoints.
 *  2. **Literal-address screening** — an IP literal in the URL is classified
 *     directly, before any DNS work.
 *  3. **DNS resolution screening** — the hostname is resolved and *every*
 *     returned address is screened, not just the first. A host with both a
 *     public and a private A record is rejected.
 *  4. **Redirect screening** — each `Location` is re-validated from step 1; a
 *     redirect to a private address is refused rather than followed.
 *
 * Known limitation, stated plainly rather than papered over: Node's built-in
 * `fetch` does not expose a connection-pinning hook, so the socket is opened to
 * the *hostname*, which undici resolves a second time. The guard therefore
 * narrows the rebinding window to the gap between our resolution and undici's;
 * it does not close it. `providers/http.ts` carries the same note at the point
 * where the connection is actually made. A deployment needing a hard guarantee
 * should route inference through the hosted gateway, which terminates the
 * connection server-side and is not subject to a client-side DNS race.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { PolicyDeniedError, ProviderError } from '../errors.js';

/** Address ranges that must never be contacted. */
export interface AddressRange {
  readonly name: string;
  readonly reason: string;
  readonly test: (address: string) => boolean;
}

/** Parse an IPv4 dotted quad to a uint32. Returns undefined for non-IPv4. */
export function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** True when `address` falls inside CIDR `base/prefixBits` (IPv4). */
export function inCidrV4(address: string, base: string, prefixBits: number): boolean {
  const a = ipv4ToInt(address);
  const b = ipv4ToInt(base);
  if (a === undefined || b === undefined) return false;
  if (prefixBits <= 0) return true;
  if (prefixBits > 32) return false;
  const mask = (0xffffffff << (32 - prefixBits)) >>> 0;
  return (a & mask) === (b & mask);
}

/** Expand an IPv6 address to its 8 groups, handling `::` and IPv4-mapped tails. */
export function expandIpv6(address: string): number[] | undefined {
  let input = address;
  // Strip a zone index (`fe80::1%eth0`).
  const zone = input.indexOf('%');
  if (zone !== -1) input = input.slice(0, zone);
  if (input.startsWith('[') && input.endsWith(']')) input = input.slice(1, -1);
  if (!input.includes(':')) return undefined;

  // A trailing dotted-quad (`::ffff:127.0.0.1`) becomes two hex groups.
  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === undefined) return undefined;
    input = `${input.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const doubleColon = input.indexOf('::');
  let head: string[];
  let tailGroups: string[];
  if (doubleColon === -1) {
    head = input.split(':');
    tailGroups = [];
  } else {
    head = input
      .slice(0, doubleColon)
      .split(':')
      .filter((s) => s !== '');
    tailGroups = input
      .slice(doubleColon + 2)
      .split(':')
      .filter((s) => s !== '');
  }

  const missing = 8 - head.length - tailGroups.length;
  if (missing < 0) return undefined;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tailGroups];
  if (groups.length !== 8) return undefined;

  const parsed = groups.map((group) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return NaN;
    return Number.parseInt(group, 16);
  });
  return parsed.some(Number.isNaN) ? undefined : parsed;
}

function inCidrV6(address: string, base: string, prefixBits: number): boolean {
  const a = expandIpv6(address);
  const b = expandIpv6(base);
  if (!a || !b) return false;
  let bits = prefixBits;
  for (let i = 0; i < 8; i += 1) {
    const groupBits = Math.min(16, Math.max(0, bits));
    if (groupBits === 0) return true;
    const mask = groupBits === 16 ? 0xffff : (0xffff << (16 - groupBits)) & 0xffff;
    if ((a[i]! & mask) !== (b[i]! & mask)) return false;
    bits -= groupBits;
  }
  return true;
}

/**
 * Address ranges that are never legitimate inference endpoints.
 *
 * Cloud metadata services are listed individually because they are the highest-
 * value SSRF target and are sometimes reachable on addresses that fall outside
 * the RFC1918 blocks (notably the IPv6 IMDS endpoint).
 */
export const BLOCKED_RANGES: readonly AddressRange[] = [
  { name: 'loopback-v4', reason: 'loopback address', test: (a) => inCidrV4(a, '127.0.0.0', 8) },
  { name: 'private-a', reason: 'RFC1918 private range', test: (a) => inCidrV4(a, '10.0.0.0', 8) },
  {
    name: 'private-b',
    reason: 'RFC1918 private range',
    test: (a) => inCidrV4(a, '172.16.0.0', 12),
  },
  {
    name: 'private-c',
    reason: 'RFC1918 private range',
    test: (a) => inCidrV4(a, '192.168.0.0', 16),
  },
  {
    name: 'link-local',
    reason: 'link-local address (includes cloud metadata at 169.254.169.254)',
    test: (a) => inCidrV4(a, '169.254.0.0', 16),
  },
  { name: 'cgnat', reason: 'carrier-grade NAT range', test: (a) => inCidrV4(a, '100.64.0.0', 10) },
  {
    name: 'benchmarking',
    reason: 'reserved benchmarking range',
    test: (a) => inCidrV4(a, '198.18.0.0', 15),
  },
  { name: 'multicast', reason: 'multicast address', test: (a) => inCidrV4(a, '224.0.0.0', 4) },
  { name: 'reserved', reason: 'reserved address range', test: (a) => inCidrV4(a, '240.0.0.0', 4) },
  { name: 'broadcast', reason: 'broadcast address', test: (a) => a === '255.255.255.255' },
  { name: 'unspecified', reason: 'unspecified address', test: (a) => a === '0.0.0.0' },
  {
    name: 'metadata-alibaba',
    reason: 'cloud instance metadata service',
    test: (a) => a === '100.100.100.200',
  },
  { name: 'loopback-v6', reason: 'IPv6 loopback', test: (a) => inCidrV6(a, '::1', 128) },
  {
    name: 'unspecified-v6',
    reason: 'IPv6 unspecified address',
    test: (a) => inCidrV6(a, '::', 128),
  },
  {
    // Specific metadata entries precede the broad ULA range below, because
    // `fd00:ec2::254` lies inside `fc00::/7` and the more precise reason is the
    // more useful diagnostic.
    name: 'metadata-aws-v6',
    reason: 'AWS IPv6 instance metadata service',
    test: (a) => inCidrV6(a, 'fd00:ec2::254', 128),
  },
  {
    name: 'ula-v6',
    reason: 'IPv6 unique-local address',
    test: (a) => inCidrV6(a, 'fc00::', 7),
  },
  {
    name: 'link-local-v6',
    reason: 'IPv6 link-local address',
    test: (a) => inCidrV6(a, 'fe80::', 10),
  },
  {
    name: 'multicast-v6',
    reason: 'IPv6 multicast address',
    test: (a) => inCidrV6(a, 'ff00::', 8),
  },
  {
    name: 'ipv4-mapped-loopback',
    reason: 'IPv4-mapped loopback address',
    test: (a) => inCidrV6(a, '::ffff:127.0.0.0', 104),
  },
  {
    name: 'ipv4-mapped-private',
    reason: 'IPv4-mapped private address',
    test: (a) => inCidrV6(a, '::ffff:10.0.0.0', 104) || inCidrV6(a, '::ffff:192.168.0.0', 112),
  },
  {
    // 6to4 and Teredo are classic SSRF tunnelling vectors: they embed an IPv4
    // address that a naive filter will not see.
    name: 'transition-mechanism',
    reason: 'IPv6 transition mechanism (6to4/Teredo) can tunnel to a private IPv4 address',
    test: (a) => inCidrV6(a, '2002::', 16) || inCidrV6(a, '2001::', 32),
  },
];

/** Classify an IP literal. Returns the blocking range, or undefined if public. */
export function classifyAddress(address: string): AddressRange | undefined {
  const family = isIP(address);
  if (family === 0) return undefined;
  for (const range of BLOCKED_RANGES) {
    if (range.test(address)) return range;
  }
  return undefined;
}

export interface SsrfGuardOptions {
  /**
   * Hostnames that are permitted despite resolving to a blocked range.
   * Intended for local inference servers (`localhost`, `127.0.0.1`) which are a
   * legitimate and common BYOK target (Ollama, llama.cpp, LM Studio).
   */
  readonly allowLoopbackHosts?: readonly string[];
  /** Whether plain `http://` is permitted for the allowed loopback hosts. */
  readonly allowInsecureLoopback?: boolean;
  /** Override the DNS resolver. Injectable for tests. */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}

export interface ValidatedEndpoint {
  readonly url: URL;
  /** Vetted IP addresses. Callers should connect to one of these. */
  readonly addresses: readonly string[];
  /** True when the endpoint is on loopback and was explicitly permitted. */
  readonly loopback: boolean;
}

export const DEFAULT_LOOPBACK_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
];

export class SsrfGuard {
  readonly #allowLoopbackHosts: ReadonlySet<string>;
  readonly #allowInsecureLoopback: boolean;
  readonly #resolve: (hostname: string) => Promise<readonly string[]>;

  constructor(options: SsrfGuardOptions = {}) {
    this.#allowLoopbackHosts = new Set(
      (options.allowLoopbackHosts ?? DEFAULT_LOOPBACK_HOSTS).map((h) => h.toLowerCase()),
    );
    this.#allowInsecureLoopback = options.allowInsecureLoopback ?? true;
    this.#resolve =
      options.resolve ??
      (async (hostname: string) => {
        const records = await dnsLookup(hostname, { all: true, verbatim: true });
        return records.map((record) => record.address);
      });
  }

  /**
   * Validate a URL and resolve every address it points at.
   *
   * Throws `PolicyDeniedError` when the endpoint is not permitted, so the caller
   * can surface it as a configuration problem rather than a network error.
   */
  async validate(rawUrl: string, context = 'endpoint'): Promise<ValidatedEndpoint> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (cause) {
      throw new PolicyDeniedError(`Invalid ${context} URL: ${rawUrl}`, {
        details: { url: rawUrl },
        cause,
        hint: 'Provide an absolute URL such as https://api.example.com/v1.',
      });
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new PolicyDeniedError(`${context} must use http or https, got “${url.protocol}”.`, {
        details: { url: rawUrl, protocol: url.protocol },
      });
    }

    // Userinfo in the URL is a credential-leak vector (it ends up in logs and
    // Referer headers). Credentials belong in headers, not the URL.
    if (url.username !== '' || url.password !== '') {
      throw new PolicyDeniedError(`${context} URL must not contain embedded credentials.`, {
        details: { url: safeUrlForDisplay(url) },
        hint: 'Pass the API key via the credential store or an environment variable instead.',
      });
    }

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLoopbackHost = this.#allowLoopbackHosts.has(hostname);

    // Literal address: classify directly, no DNS needed.
    if (isIP(hostname) !== 0) {
      const range = classifyAddress(hostname);
      if (range) {
        if (!isLoopbackHost) {
          throw this.#blocked(rawUrl, hostname, range);
        }
        if (url.protocol === 'http:' && !this.#allowInsecureLoopback) {
          throw new PolicyDeniedError(
            `Insecure http:// is not permitted for ${context} ${safeUrlForDisplay(url)}.`,
            { details: { url: safeUrlForDisplay(url) } },
          );
        }
        return { url, addresses: [hostname], loopback: true };
      }
      if (url.protocol === 'http:') {
        throw new PolicyDeniedError(
          `${context} must use https:// for non-loopback hosts (got ${safeUrlForDisplay(url)}).`,
          { details: { url: safeUrlForDisplay(url) } },
        );
      }
      return { url, addresses: [hostname], loopback: false };
    }

    // Named host: resolve and screen every address.
    let addresses: readonly string[];
    try {
      addresses = await this.#resolve(hostname);
    } catch (cause) {
      throw ProviderError.fromDns(hostname, cause);
    }

    if (addresses.length === 0) {
      // A resolution that yields nothing is a DNS failure, not a policy
      // decision — reporting it as a denial would send the user looking for a
      // permission problem that does not exist.
      throw ProviderError.fromDns(hostname);
    }

    // Strictest-wins: a host is blocked if **any** address it resolves to is
    // blocked. The inverse (block only when *every* address is blocked) is a
    // known bypass — a dual-record host would be accepted because the connection
    // may land on the private record, and DNS round-robin makes that a coin flip
    // under the attacker's control.
    let sawBlocked: AddressRange | undefined;
    for (const address of addresses) {
      const range = classifyAddress(address);
      if (range) {
        sawBlocked = range;
        break;
      }
    }

    if (sawBlocked) {
      if (isLoopbackHost) {
        if (url.protocol === 'http:' && !this.#allowInsecureLoopback) {
          throw new PolicyDeniedError(
            `Insecure http:// is not permitted for ${context} ${safeUrlForDisplay(url)}.`,
            { details: { url: safeUrlForDisplay(url) } },
          );
        }
        return { url, addresses, loopback: true };
      }
      throw this.#blocked(rawUrl, addresses.join(', '), sawBlocked);
    }

    if (url.protocol === 'http:') {
      throw new PolicyDeniedError(
        `${context} must use https:// for non-loopback hosts (got ${safeUrlForDisplay(url)}).`,
        { details: { url: safeUrlForDisplay(url) } },
      );
    }

    return { url, addresses, loopback: false };
  }

  /**
   * Validate a redirect target.
   *
   * Called for every hop. Downgrading (`https:` → `http:`) is refused outright,
   * which is the standard protection against a redirect-based TLS strip.
   */
  async validateRedirect(from: URL, location: string, hop: number): Promise<ValidatedEndpoint> {
    let target: URL;
    try {
      target = new URL(location, from);
    } catch (cause) {
      throw new PolicyDeniedError(`Provider returned an unparseable redirect: ${location}`, {
        cause,
      });
    }

    if (from.protocol === 'https:' && target.protocol === 'http:') {
      throw new PolicyDeniedError(
        `Refusing to follow a redirect that downgrades to insecure HTTP (${safeUrlForDisplay(target)}).`,
        { details: { from: safeUrlForDisplay(from), to: safeUrlForDisplay(target), hop } },
      );
    }

    return this.validate(target.toString(), `redirect (hop ${hop})`);
  }

  #blocked(rawUrl: string, address: string, range: AddressRange): PolicyDeniedError {
    return new PolicyDeniedError(
      `Refusing to connect to “${safeHostOf(rawUrl)}”: ${address} is a ${range.reason}.`,
      {
        details: { url: rawUrl, address, range: range.name },
        hint: 'Provider endpoints must be on the public internet. Local inference servers must be listed in “providers.<id>.allowLoopbackHosts”.',
      },
    );
  }
}

/** Strip userinfo and query from a URL before it can reach a log line. */
export function safeUrlForDisplay(url: URL | string): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const clone = new URL(parsed.toString());
    clone.username = '';
    clone.password = '';
    // Query strings on provider endpoints frequently carry `?key=...`.
    if (clone.search !== '') clone.search = '?…';
    return clone.toString();
  } catch {
    return '[invalid-url]';
  }
}

function safeHostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

/** Maximum number of redirects followed before giving up. */
export const MAX_REDIRECTS = 5;
