/**
 * Request signing for the webhook scenarios.
 *
 * These are INDEPENDENT re-implementations of what the backend verifies (the
 * backend verifiers live in src/modules/**; this file never imports them), so a
 * drift between sender and verifier is caught as a 401/403 instead of being
 * silently shared. Secrets come from env at run time and are never logged.
 */
import crypto from 'k6/crypto';

const hmacHex = (secret, data) => crypto.hmac('sha256', secret, data, 'hex');

/** Tap uses 3 decimals for these currencies, 2 for everything else. */
const THREE_DECIMAL = { BHD: 1, KWD: 1, OMR: 1, JOD: 1 };

/**
 * `hashstring` header for a Tap charge/authorize/refund webhook body.
 * Canonical string, no separators:
 *   x_id{id}x_amount{amount}x_currency{currency}x_gateway_reference{ref.gateway}
 *   x_payment_reference{ref.payment}x_status{status}x_created{created}
 * `created` = transaction.created for charges, top-level created for refunds.
 */
export function tapHashstring(body, secret) {
  const decimals = THREE_DECIMAL[String(body.currency).toUpperCase()] ? 3 : 2;
  const ref = body.reference || {};
  const created = body.object === 'refund'
    ? body.created
    : (body.transaction && body.transaction.created);
  const canonical =
    `x_id${body.id}x_amount${Number(body.amount).toFixed(decimals)}x_currency${body.currency}` +
    `x_gateway_reference${ref.gateway || ''}x_payment_reference${ref.payment || ''}` +
    `x_status${body.status}x_created${created}`;
  return hmacHex(secret, canonical);
}

/**
 * Inbound partner webhook, scheme `hmac_sha256_timestamped_v2`:
 *   HMAC_SHA256(secret, timestamp \n eventId \n eventType \n rawBody)
 * The secret is used as the UTF-8 key string exactly as issued.
 */
export function inboundV2Headers(secret, eventId, eventType, rawBody) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = hmacHex(secret, [ts, eventId, eventType, rawBody].join('\n'));
  return {
    'Content-Type': 'application/json',
    'x-ziyarati-signature': `sha256=${sig}`,
    'x-ziyarati-timestamp': ts,
    'x-ziyarati-event-id': eventId,
    'x-ziyarati-event': eventType,
  };
}

/** Meta/WhatsApp: `X-Hub-Signature-256: sha256=<hmac of the EXACT raw body>`. */
export function metaSignatureHeader(rawBody, appSecret) {
  return `sha256=${hmacHex(appSecret, rawBody)}`;
}
