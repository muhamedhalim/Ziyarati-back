import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Outbound webhook constants (Phase 2 — Integration platform).
 *
 * Event allowlist is deliberately limited to event names that ALREADY fire
 * today via EventEmitter2 (see src/events/appointment.events.ts and
 * payment.events.ts, both already consumed by NotificationEventListener /
 * WorkflowEventListener) — no speculative events with no real trigger.
 */
export const WEBHOOK_EVENT = {
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_CONFIRMED: 'appointment.confirmed',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  APPOINTMENT_COMPLETED: 'appointment.completed',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',
  APPOINTMENT_NO_SHOW: 'appointment.no_show',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_REFUNDED: 'payment.refunded',
  PAYMENT_FAILED: 'payment.failed',
} as const;

export type WebhookEventName = (typeof WEBHOOK_EVENT)[keyof typeof WEBHOOK_EVENT];

/**
 * Synthetic event behind "Send test event" — lets an integrator verify their
 * receiver (URL reachable, signature verified, 2xx returned) without waiting for
 * a real appointment/payment. Deliberately NOT part of `WEBHOOK_EVENT`: it is
 * never subscribable (an endpoint's `events` allowlist rejects it) and is only
 * ever created by `WebhookDeliveryService.sendTest`, straight through the
 * normal delivery pipeline (same signing, SSRF guard, retries and history).
 */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export const WEBHOOK_EVENTS: WebhookEventName[] = Object.values(WEBHOOK_EVENT);
const WEBHOOK_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

/** Filters an arbitrary string array down to only recognised event names (legacy/junk-safe). */
export function normalizeWebhookEvents(raw: unknown): WebhookEventName[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WebhookEventName[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && WEBHOOK_EVENT_SET.has(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v as WebhookEventName);
    }
  }
  return out;
}

/** WebhookDelivery.status values (free-form varchar column). */
export const WEBHOOK_DELIVERY_STATUS = {
  PENDING: 'PENDING',
  DELIVERING: 'DELIVERING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  DEAD_LETTERED: 'DEAD_LETTERED',
} as const;
export type WebhookDeliveryStatus =
  (typeof WEBHOOK_DELIVERY_STATUS)[keyof typeof WEBHOOK_DELIVERY_STATUS];

export const WEBHOOK_SECRET_PREFIX = 'whsec';

/** Generate a new webhook signing secret. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}_${randomBytes(32).toString('base64url')}`;
}

/** First few characters of the plaintext secret — safe to display, never re-derivable to the full value. */
export function webhookSecretPrefix(plaintext: string): string {
  return plaintext.slice(0, 12);
}

/** Response headers sent with every outbound delivery. */
export const WEBHOOK_HEADER = {
  ID: 'X-Webhook-Id',
  EVENT: 'X-Webhook-Event',
  TIMESTAMP: 'X-Webhook-Timestamp',
  SIGNATURE: 'X-Webhook-Signature',
} as const;

/**
 * Computes the outbound signature: HMAC-SHA256 over `"{timestampSeconds}.{rawBody}"`,
 * emitted as `sha256=<hex>` (same convention this codebase already uses for
 * verifying INBOUND Meta signatures — see WebhookSignatureVerifier). Signing
 * over timestamp+body (not body alone) is what lets the receiver's own
 * verification reject a replayed-but-otherwise-valid signature by rejecting a
 * stale timestamp — REPLAY PROTECTION lives in the receiver's verification
 * logic, which this scheme is documented (Swagger) to support.
 */
export function computeWebhookSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `sha256=${digest}`;
}

/**
 * Constant-time verification of a `computeWebhookSignature` output. Exposed
 * for our own tests and for anyone re-deriving what a tenant's receiver
 * should do — this codebase never receives its own webhooks back, so nothing
 * in the runtime calls this outside tests.
 */
export function verifyWebhookSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
  presented: string,
): boolean {
  const expected = computeWebhookSignature(secret, timestampSeconds, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Deterministic short hash used only for idempotency-key/log correlation, never for secrecy. */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Max serialized payload size sent to a tenant endpoint — payloads are ids/scalars only, so this is generous headroom. */
export const WEBHOOK_PAYLOAD_MAX_BYTES = 65_536;

/** Response bytes read from a tenant endpoint before the socket is cut short — only the first ~500 chars are ever persisted as a preview, so there is no reason to wait for or buffer a large/slow body. */
export const WEBHOOK_RESPONSE_READ_CAP_BYTES = 32_768;
