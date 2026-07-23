/**
 * Outbound webhook delivery retry classification (Phase 2 gap-closure).
 *
 * Delivery is AT-LEAST-ONCE, never exactly-once: a transient classification
 * here means "throw so BullMQ retries the job" (same convention as
 * CampaignDispatchService's TransientDispatchError), which can, in rare races
 * (e.g. the receiver accepted the request but the response was lost), result
 * in the same event being delivered more than once. Receivers MUST dedupe on
 * `X-Webhook-Id` (stable across every automatic retry of one delivery — see
 * WebhookDeliveryProcessor) — this is documented on the endpoint's Swagger
 * description and in the delivery-headers contract, not silently assumed.
 *
 * Event ORDERING is not guaranteed either: concurrent workers, per-attempt
 * backoff, and manual replay can all cause two events for the same tenant to
 * arrive out of their original emission order. Nothing in this module (or the
 * queue config) currently provides ordering — callers must not assume it.
 */

/** HTTP statuses worth retrying: request timeout, "too early", rate-limited, and any server error. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * A 3xx response means the receiver asked us to follow a redirect — outbound
 * webhook delivery deliberately never does (see webhook-ssrf.ts), since
 * blindly following a receiver-controlled redirect is itself an SSRF vector.
 * Treated as a permanent misconfiguration on the receiver's side, not a
 * transient fault — retrying an unfollowed redirect will never succeed.
 */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

export type WebhookOutcomeClassification = 'success' | 'retryable' | 'permanent';

/** Classifies a completed HTTP response (never called for network-level failures — see below). */
export function classifyWebhookHttpOutcome(status: number): WebhookOutcomeClassification {
  if (status >= 200 && status < 300) return 'success';
  if (isRedirectStatus(status)) return 'permanent';
  if (isRetryableHttpStatus(status)) return 'retryable';
  return 'permanent';
}

/**
 * Network-level failures (DNS lookup errors, connection refused/reset, TLS
 * failures, request timeout) are always retryable — the target may simply be
 * temporarily unreachable. The one exception is a delivery blocked by the
 * SSRF guard (see `SsrfBlockedError` in webhook-ssrf.ts): that is a policy
 * decision, not a network fault, and must never be retried regardless of how
 * it is thrown — callers check for that error type BEFORE reaching this
 * classification, not through it.
 */
export function isRetryableNetworkError(): true {
  return true;
}
