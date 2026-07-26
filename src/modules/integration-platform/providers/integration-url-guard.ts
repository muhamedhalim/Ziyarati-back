import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

import { AppError, ErrorCode } from '../../../common/errors';
import {
  DANGEROUS_PORTS,
  isBlockedIpv4,
  isBlockedIpv6Bytes,
  parseIpv6ToBytes,
} from '../../platform/webhook-url-guard';

/**
 * SSRF guard for tenant-supplied Generic REST connection base URLs.
 *
 * Deliberately STRICTER than `modules/platform/webhook-url-guard.ts` (which
 * intentionally allows plain http and never permits private hosts — that
 * guard protects a RECEIVER url). A connection base URL is where OUR server
 * sends live requests carrying tenant secrets (API keys, bearer tokens,
 * Basic Auth passwords), so in PRODUCTION this requires https and refuses
 * private/loopback/link-local/metadata hosts BY DEFAULT. Both restrictions
 * can only be lifted by an explicit BACKEND env flag — never by anything a
 * tenant submits — for genuinely on-prem/self-hosted PMS deployments an
 * operator has reviewed. In non-production (dev/test) both are relaxed
 * automatically so a developer can point a connection at a local mock server.
 *
 * Same two-layer model as the webhook guard:
 *  1. `assertSafeIntegrationBaseUrl` — literal, synchronous checks. Used at
 *     connection create/update time AND as step 1 of layer 2.
 *  2. `resolveSafeIntegrationTarget` — DNS-resolves every A/AAAA record,
 *     rejects the whole target if any resolved address is unsafe, and
 *     returns ONE pinned literal address the caller must connect to
 *     (closing the DNS-rebinding TOCTOU window). Called before EVERY
 *     outbound call — health check, test-connection, pull/push sync — never
 *     only once at save time.
 */

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Explicit, backend-only escape hatches — never settable by tenant input. */
export function allowInsecureBaseUrlScheme(): boolean {
  return !isProduction() || process.env.INTEGRATION_ALLOW_INSECURE_BASE_URL === 'true';
}
export function allowPrivateBaseUrlHost(): boolean {
  return !isProduction() || process.env.INTEGRATION_ALLOW_PRIVATE_BASE_URL === 'true';
}

/** Thrown by `resolveSafeIntegrationTarget` when DNS resolves but every address is blocked. PERMANENT — never retry. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface PinnedIntegrationTarget {
  /** Literal IP to connect to — MUST be used as-is, never re-resolved. */
  address: string;
  family: 4 | 6;
}

/** Trim + strip trailing slash(es). Applied before validation and storage. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Scheme/credentials/port/host-range checks shared by both the stored-base-URL
 * validator and the per-request validator below. Deliberately does NOT touch
 * `search`/`hash` — a query string is forbidden on the STORED base URL (it
 * would let a tenant smuggle request parameters outside the validated config)
 * but is completely normal on the assembled per-REQUEST URL (pagination, an
 * API key sent as a query param, ...).
 */
function assertSafeHostAndScheme(url: URL): void {
  const fail = (message: string): never => {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message });
  };

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('Base URL must use http or https');
  }
  if (url.protocol === 'http:' && !allowInsecureBaseUrlScheme()) {
    fail('Base URL must use https in production');
  }
  if (url.username || url.password) {
    fail('Base URL must not contain credentials');
  }
  if (url.port) {
    const port = Number(url.port);
    if (DANGEROUS_PORTS.has(port)) fail(`Base URL port ${port} is not allowed`);
  }

  if (allowPrivateBaseUrlHost()) return; // dev/test, or explicitly opted in

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) fail('Base URL host is loopback');
  if (host.endsWith('.internal') || host.endsWith('.local')) fail('Base URL host is internal');

  const literalFamily = isIP(host);
  if (literalFamily === 4) {
    if (isBlockedIpv4(host)) fail('Base URL host is a blocked IPv4 address');
  } else if (literalFamily === 6) {
    const bytes = parseIpv6ToBytes(host);
    if (!bytes || isBlockedIpv6Bytes(bytes)) fail('Base URL host is a blocked IPv6 address');
  }
}

/** Literal, synchronous checks for the STORED base URL. Throws AppError(VALIDATION_ERROR) with a safe, specific message. */
export function assertSafeIntegrationBaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Base URL is not a valid URL' });
  }
  if (url.search || url.hash) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Base URL must not include a query string or fragment',
    });
  }
  assertSafeHostAndScheme(url);
}

/**
 * Layer 2 — see file docstring. Re-validates the actual per-REQUEST URL
 * (base + resource path + query string — a query string here is normal, see
 * `assertSafeHostAndScheme`) then resolves + pins a single safe address.
 */
export async function resolveSafeIntegrationTarget(url: URL): Promise<PinnedIntegrationTarget> {
  assertSafeHostAndScheme(url);

  const skipRangeCheck = allowPrivateBaseUrlHost();
  const blockedV4 = (addr: string) => !skipRangeCheck && isBlockedIpv4(addr);
  const blockedV6 = (addr: string) => {
    if (skipRangeCheck) return false;
    const bytes = parseIpv6ToBytes(addr);
    return !bytes || isBlockedIpv6Bytes(bytes);
  };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const literalFamily = isIP(host);
  if (literalFamily === 4) {
    if (blockedV4(host)) throw new SsrfBlockedError('Base URL host is a blocked IPv4 address');
    return { address: host, family: 4 };
  }
  if (literalFamily === 6) {
    if (blockedV6(host)) throw new SsrfBlockedError('Base URL host is a blocked IPv6 address');
    return { address: host, family: 6 };
  }

  const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
  const candidates: PinnedIntegrationTarget[] = [];
  if (v4.status === 'fulfilled') candidates.push(...v4.value.map((a) => ({ address: a, family: 4 as const })));
  if (v6.status === 'fulfilled') candidates.push(...v6.value.map((a) => ({ address: a, family: 6 as const })));

  if (candidates.length === 0) {
    // Resolver/network may simply be unavailable — TRANSIENT, not a block.
    throw new Error(`Could not resolve base URL host "${host}"`);
  }

  for (const candidate of candidates) {
    const blocked = candidate.family === 4 ? blockedV4(candidate.address) : blockedV6(candidate.address);
    if (blocked) throw new SsrfBlockedError(`Base URL host "${host}" resolves to a blocked address`);
  }
  return candidates.find((a) => a.family === 4) ?? candidates[0];
}
