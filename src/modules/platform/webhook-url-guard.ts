import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

import { AppError, ErrorCode } from '../../common/errors';

/**
 * SSRF guard for tenant-supplied outbound webhook endpoint URLs.
 *
 * Deliberately independent from `modules/ai/execution/deployment-validation
 * .ts`'s `assertSafeDeploymentBaseUrl`. Protocol policy: https only in
 * production (`allowInsecureWebhookScheme`); http is additionally allowed in
 * dev/test. The check runs again before EVERY delivery attempt, so an endpoint
 * stored with `http://` before this rule existed is refused at delivery too.
 *
 * TWO LAYERS, used at different times:
 *
 *  1. `assertSafeWebhookUrl` — literal, synchronous checks (scheme,
 *     credentials, dangerous ports, and the URL's literal hostname/IP
 *     against the blocklist below). Cheap; used for fast-fail UX at
 *     create/update time, and as the first step of layer 2.
 *
 *  2. `resolveSafeWebhookTarget` — DNS-resolves the hostname (ALL A + AAAA
 *     records), validates every resolved address, and returns the ONE address
 *     the caller must connect to. Called immediately before EVERY delivery
 *     attempt (initial send, automatic retry, manual replay — see
 *     WebhookDeliveryProcessor / webhook-http-client.ts), never only at
 *     creation time. The caller pinning the returned address for the actual
 *     socket connection (instead of letting the HTTP stack re-resolve the
 *     hostname itself) is what closes the DNS-rebinding TOCTOU window: a
 *     hostname that resolves safely here but would resolve to an internal IP
 *     a second later (rebinding) can never reach that second lookup, because
 *     there IS no second lookup — the pinned literal IP is used directly.
 */

/** IPv4 in a private / loopback / link-local / CGNAT / multicast / reserved range. */
export function isBlockedIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if ([a, b, c, d].some((n) => n > 255)) return true; // malformed → block
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18.0.0/15 benchmarking
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 documentation (TEST-NET-1)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 documentation (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 documentation (TEST-NET-3)
  return false;
}

/** Parses a (bracket-stripped) IPv6 literal into 16 bytes, or null if unparseable. Assumes no embedded dotted-quad (WHATWG URL / Node's dns module both normalize those to hex groups already). */
export function parseIpv6ToBytes(raw: string): Uint8Array | null {
  const host = raw.trim().toLowerCase();
  if (!host || host.includes('.') || !/^[0-9a-f:]+$/.test(host)) return null;

  const doubleColonCount = (host.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  const hasDoubleColon = host.includes('::');
  let headGroups: string[] = [];
  let tailGroups: string[] = [];

  if (hasDoubleColon) {
    const idx = host.indexOf('::');
    const headPart = host.slice(0, idx);
    const tailPart = host.slice(idx + 2);
    headGroups = headPart.length ? headPart.split(':') : [];
    tailGroups = tailPart.length ? tailPart.split(':') : [];
    if (headGroups.length + tailGroups.length >= 8) return null; // "::" must collapse >=1 group
  } else {
    headGroups = host.split(':');
    if (headGroups.length !== 8) return null;
  }

  const missing = hasDoubleColon ? 8 - headGroups.length - tailGroups.length : 0;
  const allGroups = hasDoubleColon
    ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
    : headGroups;
  if (allGroups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = allGroups[i];
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const val = parseInt(g, 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

/** IPv6 loopback / unspecified / link-local / unique-local(private) / multicast / IPv4-mapped-or-compatible(recurses into v4 check) / documentation. */
export function isBlockedIpv6Bytes(bytes: Uint8Array): boolean {
  const isZero = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
    return true;
  };

  if (isZero(0, 16)) return true; // :: unspecified
  if (isZero(0, 15) && bytes[15] === 1) return true; // ::1 loopback
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local (private)
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 documentation

  // Transition mechanisms that EMBED an IPv4 address. A translator/relay on the
  // path would deliver to that IPv4 host, so the embedded address is judged by
  // the IPv4 rules (a NAT64 or 6to4 form of 127.0.0.1 / 169.254.169.254 must
  // not slip through as "just another public IPv6").
  const embeddedV4 = (o: number) => `${bytes[o]}.${bytes[o + 1]}.${bytes[o + 2]}.${bytes[o + 3]}`;
  const isNat64Prefix = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;
  // 64:ff9b::/96 — NAT64 well-known prefix (RFC 6052): v4 in the last 32 bits.
  if (isNat64Prefix && isZero(4, 12)) return isBlockedIpv4(embeddedV4(12));
  // 64:ff9b:1::/48 — local-use NAT64 (RFC 8215): operator-local, never a public target.
  if (isNat64Prefix && bytes[4] === 0x00 && bytes[5] === 0x01) return true;
  // 2002::/16 — 6to4 (RFC 3056): v4 in bytes 2..5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isBlockedIpv4(embeddedV4(2));
  // 2001:0::/32 — Teredo (RFC 4380): tunnels via a client-chosen relay; no legitimate receiver.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;

  // ::ffff:a.b.c.d/96 (IPv4-mapped) and ::a.b.c.d/96 (IPv4-compatible, legacy) — recurse into the embedded IPv4.
  const isMapped = isZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompatible = isZero(0, 12) && !isZero(12, 16);
  if (isMapped || isCompatible) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isBlockedIpv4(v4);
  }
  return false;
}

/** Exported so other outbound-URL guards (e.g. integration base URLs) share one vetted list. */
export const DANGEROUS_PORTS = new Set([
  22, 23, 25, 53, 110, 135, 139, 143, 161, 389, 445, 512, 513, 514,
  1433, 1521, 2375, 2376, 3306, 3389, 5432, 5984, 6379, 8500, 9200,
  11211, 27017,
]);

/**
 * Plain `http://` receivers are refused in production: signed deliveries carry
 * appointment/customer identifiers, and a MAC gives integrity, not
 * confidentiality. Relaxed outside production so local mocks work.
 *
 * `WEBHOOK_ALLOW_INSECURE_HTTP` is a BACKEND env override, never a request
 * field: `true` allows http even in production (operator-reviewed on-prem
 * deployments); `false` enforces https in non-production too (staging, tests);
 * unset follows NODE_ENV.
 */
export function allowInsecureWebhookScheme(): boolean {
  const flag = process.env.WEBHOOK_ALLOW_INSECURE_HTTP;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/** Literal, synchronous checks — scheme/credentials/port/literal-host. See file docstring for the two-layer model. */
export function assertSafeWebhookUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Webhook URL is not a valid URL' });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Webhook URL must use http or https',
    });
  }
  if (url.protocol === 'http:' && !allowInsecureWebhookScheme()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Webhook URL must use https',
      publicContext: { reason: 'https_required' },
    });
  }
  if (url.username || url.password) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Webhook URL must not contain credentials',
    });
  }

  if (url.port) {
    const port = Number(url.port);
    if (DANGEROUS_PORTS.has(port)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Webhook URL port ${port} is not allowed`,
      });
    }
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const fail = (message: string): never => {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message });
  };

  if (host === 'localhost' || host.endsWith('.localhost')) fail('Webhook URL host is loopback');
  if (host.endsWith('.internal') || host.endsWith('.local')) fail('Webhook URL host is internal');

  const literalFamily = isIP(host);
  if (literalFamily === 4) {
    if (isBlockedIpv4(host)) fail('Webhook URL host is a blocked IPv4 address');
  } else if (literalFamily === 6) {
    const bytes = parseIpv6ToBytes(host);
    if (!bytes || isBlockedIpv6Bytes(bytes)) fail('Webhook URL host is a blocked IPv6 address');
  }
}

/** Thrown by `resolveSafeWebhookTarget` when DNS resolution succeeds but every resolved address (or the literal IP) is blocked. Callers must treat this as PERMANENT — never retry a blocked target. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface PinnedWebhookTarget {
  /** The literal IP address to connect to — MUST be used as-is for the socket, never re-resolved. */
  address: string;
  family: 4 | 6;
}

/**
 * Layer 2 — see file docstring. Re-runs the literal checks (defensive: an
 * endpoint's URL could in principle have been validated under a since-loosened
 * rule) then resolves every A/AAAA record for the hostname, rejects the whole
 * target if ANY resolved address is unsafe, and returns exactly one safe,
 * literal address to pin the connection to.
 *
 * A DNS resolution failure (no records / NXDOMAIN / resolver error) throws a
 * plain `Error` — callers classify that as a TRANSIENT fault (the resolver or
 * network could be temporarily unavailable) via webhook-retry-policy.ts. A
 * blocked address throws `SsrfBlockedError` — always PERMANENT.
 */
export async function resolveSafeWebhookTarget(url: URL): Promise<PinnedWebhookTarget> {
  assertSafeWebhookUrl(url.toString());

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const literalFamily = isIP(host);
  if (literalFamily === 4) {
    if (isBlockedIpv4(host)) throw new SsrfBlockedError('Webhook host is a blocked IPv4 address');
    return { address: host, family: 4 };
  }
  if (literalFamily === 6) {
    const bytes = parseIpv6ToBytes(host);
    if (!bytes || isBlockedIpv6Bytes(bytes)) {
      throw new SsrfBlockedError('Webhook host is a blocked IPv6 address');
    }
    return { address: host, family: 6 };
  }

  const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
  const candidates: PinnedWebhookTarget[] = [];
  if (v4.status === 'fulfilled') candidates.push(...v4.value.map((a) => ({ address: a, family: 4 as const })));
  if (v6.status === 'fulfilled') candidates.push(...v6.value.map((a) => ({ address: a, family: 6 as const })));

  if (candidates.length === 0) {
    throw new Error(`Could not resolve webhook host "${host}"`);
  }

  for (const candidate of candidates) {
    const blocked =
      candidate.family === 4
        ? isBlockedIpv4(candidate.address)
        : (() => {
            const bytes = parseIpv6ToBytes(candidate.address);
            return !bytes || isBlockedIpv6Bytes(bytes);
          })();
    if (blocked) {
      throw new SsrfBlockedError(`Webhook host "${host}" resolves to a blocked address`);
    }
  }

  return candidates.find((a) => a.family === 4) ?? candidates[0];
}
