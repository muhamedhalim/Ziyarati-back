import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
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
  if (!edgeToken) return undefined;

  const presented = req.headers[EDGE_TOKEN_HEADER];
  const presentedValue = Array.isArray(presented) ? presented[0] : presented;
  if (typeof presentedValue !== 'string' || !tokensEqual(presentedValue, edgeToken)) {
    return undefined;
  }

  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof header !== 'string') return undefined;

  const parts = header.split(',').map((p) => p.trim());
  if (parts.length < 2) return undefined;

  // The ALB-appended entry must be the address Express resolved; otherwise the
  // chain is not what we assume (no ALB, `preserve` mode, hops misconfigured).
  if (parts[parts.length - 1] !== req.ip) return undefined;

  const candidate = parts[parts.length - 2];
  return isIP(candidate) !== 0 ? candidate : undefined;
}
