import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  INBOUND_HEADER,
  WEBHOOK_SIGNATURE_SCHEME,
  WebhookSignatureScheme,
} from '../integration-platform.constants';

/**
 * Inbound webhook signature verification (pure, side-effect-free).
 *
 * Every strategy here is COMPILED. A tenant selects a scheme by key and supplies
 * a shared secret — it can never supply verification code, a URL, or a callback,
 * so there is no injection or SSRF surface. A provider adapter may override
 * verification (see `IntegrationProviderAdapter.verifyWebhook`) but only from
 * compiled adapter code, for the same reason.
 *
 * All comparisons are CONSTANT-TIME. Verification runs over the RAW request
 * bytes, never a re-serialized object: JSON.stringify round-tripping reorders
 * keys and changes whitespace, which would make a valid signature fail (and, far
 * worse, invite a "just skip verification" workaround).
 */

export type InboundHeaders = Record<string, string | undefined>;

/** Case-insensitive header read (Node lowercases, but callers may not). */
export function header(headers: InboundHeaders, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Constant-time equality that never leaks length through an early return. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** The signed string for a scheme. Timestamped schemes bind ts INTO the MAC. */
export function signingPayload(
  scheme: WebhookSignatureScheme,
  timestamp: string | undefined,
  rawBody: string,
): string {
  return scheme === WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_BODY
    ? rawBody
    : `${timestamp ?? ''}.${rawBody}`;
}

/** `sha256=<hex>` for the given scheme — the value a caller must send. */
export function computeInboundSignature(
  scheme: WebhookSignatureScheme,
  secret: string,
  timestamp: string | undefined,
  rawBody: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(signingPayload(scheme, timestamp, rawBody))
    .digest('hex');
  return `sha256=${digest}`;
}

/**
 * Verify a presented signature. Accepts the value with or without the `sha256=`
 * prefix so a provider that omits it is not rejected for cosmetics — the MAC
 * itself is what must match.
 */
export function verifyInboundSignature(
  scheme: WebhookSignatureScheme,
  secret: string,
  timestamp: string | undefined,
  rawBody: string,
  presented: string,
): boolean {
  if (!presented || !secret) return false;
  const expected = computeInboundSignature(scheme, secret, timestamp, rawBody);
  if (safeEqual(expected, presented)) return true;
  // Tolerate a bare hex digest (no `sha256=` prefix).
  return safeEqual(expected.slice('sha256='.length), presented);
}

export type TimestampVerdict = 'ok' | 'missing' | 'stale' | 'future' | 'malformed';

/**
 * Replay-window check. A timestamp far in the PAST means a captured request is
 * being replayed; one far in the FUTURE means a caller is trying to mint a
 * signature that stays valid indefinitely. Both are refused.
 *
 * Schemes that do not bind the timestamp into the MAC cannot be protected this
 * way (an attacker would simply edit the header), so the check is skipped for
 * them and replay protection rests entirely on the persisted event id.
 */
export function verifyTimestamp(
  scheme: WebhookSignatureScheme,
  presented: string | undefined,
  toleranceSeconds: number,
  nowMs: number = Date.now(),
): TimestampVerdict {
  if (scheme === WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_BODY) return 'ok';
  if (!presented) return 'missing';
  const ts = Number(presented);
  if (!Number.isFinite(ts) || ts <= 0) return 'malformed';
  const skewSeconds = Math.floor(nowMs / 1000) - Math.floor(ts);
  if (skewSeconds > toleranceSeconds) return 'stale';
  if (skewSeconds < -toleranceSeconds) return 'future';
  return 'ok';
}

/** Convenience: read the standard inbound headers. */
export function readInboundHeaders(headers: InboundHeaders) {
  return {
    signature: header(headers, INBOUND_HEADER.SIGNATURE),
    timestamp: header(headers, INBOUND_HEADER.TIMESTAMP),
    eventId: header(headers, INBOUND_HEADER.EVENT_ID),
    eventType: header(headers, INBOUND_HEADER.EVENT_TYPE),
  };
}
