import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Client-address resolution behind the AWS ALB (WELL-ARCHITECTED-REVIEW.md
 * SEC-02; the "future trusted-proxy configuration" spec 009 CL-1 deferred).
 *
 * THE PROBLEM: with `trust proxy` unset, `req.ip` is the socket peer — behind
 * an ALB that is the load balancer's own private address for EVERY request. The
 * default throttler (300/min/route) and every per-IP `@Throttle()` then share
 * one bucket platform-wide, so one abuser can exhaust it for everybody.
 *
 * WHAT CAN BE TRUSTED. The ALB runs in `xff_header_processing_mode = append`
 * (pinned in Terraform): it APPENDS the address of its TCP peer to
 * `X-Forwarded-For`. So the LAST entry is written by AWS and cannot be forged;
 * every entry to its left is whatever the caller (or an upstream proxy) sent.
 *
 *   hops = 1  → Express trusts exactly the ALB. `req.ip` = the ALB's peer:
 *               - direct callers (WebSocket, Meta/Tap/SES webhooks, API keys):
 *                 their real address — fixed here;
 *               - browser REST traffic through the Next.js rewrite: Vercel's
 *                 egress address, i.e. exactly what a throttler can honestly
 *                 know today. Never spoofable. This is NOT per-user.
 *
 * PER-USER BEHIND VERCEL needs one more fact the backend cannot derive from
 * headers alone: that the request really came through Vercel (which overwrites
 * `X-Forwarded-For` with the client's address). Without that, trusting the
 * second-from-last entry would hand an attacker unlimited fresh buckets. So it
 * is OPT-IN and proof-based: only when `EDGE_PROXY_TOKEN` is configured AND the
 * request presents the same secret in `X-ZT-Edge-Token` (constant-time
 * compare) is the entry to the left of the ALB-appended one used. Nothing sets
 * that header yet — the Vercel side is a follow-up — so by default this is
 * inert and behaviour equals `hops = 1`.
 */

export const EDGE_TOKEN_HEADER = 'x-zt-edge-token';

/** Allowed values: 0 = unchanged legacy behaviour, 1 = trust the ALB only. */
export const MAX_TRUST_PROXY_HOPS = 1;

/**
 * Sets Express's `trust proxy` to an exact hop COUNT (never `true`, which would
 * trust the whole header and re-open the spoofing hole).
 */
export function applyTrustProxy(app: INestApplication, hops: number): void {
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_TRUST_PROXY_HOPS) {
    throw new Error(
      `TRUST_PROXY_HOPS must be an integer between 0 and ${MAX_TRUST_PROXY_HOPS}, got ${hops}`,
    );
  }
  if (hops === 0) return;
  // Express's own setting; Nest exposes the underlying instance.
  (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set(
    'trust proxy',
    hops,
  );
}

function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The address a per-client limit should be keyed on, or `undefined` when the
 * caller should use the framework's own default (`req.ips[0] ?? req.ip`).
 *
 * Returns a value only for a request that PROVED it came through the trusted
 * edge, and only when the forwarded chain is exactly as expected (the last
 * entry equals `req.ip`, i.e. Express really did trust the ALB hop, and the
 * entry to its left is a syntactically valid IP). Any doubt → `undefined`.
 */
export function resolveEdgeClientAddress(
  req: Request,
  edgeToken: string | undefined,
): string | undefined {
  if (!edgeProven(req.headers, edgeToken)) return undefined;

  const parts = forwardedChain(req.headers);
  if (parts.length < 2) return undefined;

  // The ALB-appended entry must be the address Express resolved; otherwise the
  // chain is not what we assume (no ALB, `preserve` mode, hops misconfigured).
  if (parts[parts.length - 1] !== req.ip) return undefined;

  const candidate = parts[parts.length - 2];
  return isIP(candidate) !== 0 ? candidate : undefined;
}

const CLIENT_ADDRESS = Symbol.for('zt.clientAddress');

/**
 * RL-19 — resolves the client address ONCE per request: the edge-proven
 * client when the request carries a valid edge token, otherwise `req.ip`.
 * Register right after {@link applyTrustProxy}. Everything that keys or logs
 * a per-client value (login lockout, session rows, access/security logs)
 * reads it through {@link getClientAddress}, so they all agree with the
 * throttler instead of grouping every browser behind Vercel's egress IP.
 */
export function createClientAddressMiddleware(edgeToken: string | undefined) {
  return (req: Request, _res: unknown, next: () => void): void => {
    (req as unknown as Record<symbol, unknown>)[CLIENT_ADDRESS] =
      resolveEdgeClientAddress(req, edgeToken) ?? req.ip;
    next();
  };
}

/** The address set by {@link createClientAddressMiddleware}, or `req.ip` when it did not run. */
export function getClientAddress(req: Request): string | undefined {
  const resolved = (req as unknown as Record<symbol, unknown>)[CLIENT_ADDRESS];
  return typeof resolved === 'string' ? resolved : req.ip;
}

/**
 * RL-04 — the same trust rules for a Socket.IO handshake, which never passes
 * through Express: engine.io's `handshake.address` is the raw TCP peer and
 * ignores `trust proxy`, so behind the ALB it is the load balancer's own
 * private address for EVERY visitor (one shared per-source bucket).
 *
 *   hops = 0 → the TCP peer (unchanged legacy behaviour);
 *   hops = 1 → the last `X-Forwarded-For` entry, written by the ALB and not
 *              forgeable; the peer when that entry is missing or not an IP;
 *   a request proving the trusted edge (`EDGE_PROXY_TOKEN`) → the entry to the
 *   left of the ALB-appended one, exactly as {@link resolveEdgeClientAddress}.
 *
 * Returns `undefined` only when there is no peer address at all — callers then
 * skip a per-address bound rather than invent a shared key.
 */
export function resolveHandshakeClientAddress(
  handshake: { address?: string; headers?: IncomingHttpHeaders } | undefined,
  hops: number,
  edgeToken: string | undefined,
): string | undefined {
  const peer = handshake?.address?.replace(/^::ffff:/, '') || undefined;
  if (hops < 1 || !handshake?.headers) return peer;

  const parts = forwardedChain(handshake.headers);
  const albAppended = parts[parts.length - 1];
  if (!albAppended || isIP(albAppended) === 0) return peer;

  if (parts.length >= 2 && edgeProven(handshake.headers, edgeToken)) {
    const candidate = parts[parts.length - 2];
    if (isIP(candidate) !== 0) return candidate;
  }
  return albAppended;
}

function edgeProven(
  headers: IncomingHttpHeaders,
  edgeToken: string | undefined,
): boolean {
  if (!edgeToken) return false;
  const presented = headers[EDGE_TOKEN_HEADER];
  const presentedValue = Array.isArray(presented) ? presented[0] : presented;
  return (
    typeof presentedValue === 'string' && tokensEqual(presentedValue, edgeToken)
  );
}

function forwardedChain(headers: IncomingHttpHeaders): string[] {
  const raw = headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof header !== 'string') return [];
  return header
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}
