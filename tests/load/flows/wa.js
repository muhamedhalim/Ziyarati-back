/**
 * WhatsApp inbound webhook (`POST /whatsapp/webhooks/events`).
 *
 * The API only verifies, stores and enqueues; asynchronous processing happens in
 * the worker. So the HTTP path (this flow) and the worker path (queue depth,
 * `whatsapp-webhook` job latency, measured by lab/monitor) are reported SEPARATELY.
 *
 * SAFETY (read before enabling message events):
 *  - `message_status` events are DB-only in the worker: no AI, no Meta call.
 *  - `messages` events make the worker run an AI turn and try a Meta send. They are
 *    OFF unless LT_WA_MESSAGES=true, and only safe when the target accounts are
 *    tokenless (the send fails before any network call) and/or the tenants have
 *    `bot_enabled=false` — lab/seed-campaign.mjs creates exactly that. With a
 *    worker that has any real token or AI key, do NOT enable them.
 *
 * pack-wa.json: [{ phoneNumberId }]   (whatsapp_accounts rows; tokenless)
 * Env: LT_META_APP_SECRET (the lab's fake META_APP_SECRET; never a real one).
 *
 * The signature is HMAC-SHA256 of the EXACT bytes sent, hex, `sha256=` prefixed.
 * The event timestamp must be within 7 days. Ids (wamid) must be unique per
 * delivery or the request is a dedupe hit.
 */
import http from 'k6/http';
import { BASE } from '../helpers/auth.js';
import { observe, webhookAccepted, webhookDuplicate, webhookRejected } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { pack } from '../helpers/sessions.js';
import { metaSignatureHeader } from '../helpers/signing.js';

const ACCOUNTS = pack('wa');
const SECRET = __ENV.LT_META_APP_SECRET || '';
const MESSAGES = __ENV.LT_WA_MESSAGES === 'true';

function envelope(phoneNumberId, valueExtra) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_LT',
      changes: [{
        field: 'messages',
        value: Object.assign({
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
        }, valueExtra),
      }],
    }],
  };
}

function post(body, step, kind) {
  const raw = JSON.stringify(body);
  const res = http.post(`${BASE}/api/v1/whatsapp/webhooks/events`, raw, {
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': metaSignatureHeader(raw, SECRET) },
    tags: { step, name: `wa/${kind}` },
    responseCallback: http.expectedStatuses(200, 401, 429),
  });
  observe(res, `wa:${kind}`, step);
  if (res.status === 200) {
    let b = {};
    try { b = res.json(); } catch (e) { /* ignore */ }
    if (b.deduplicated) webhookDuplicate.add(1, { kind: `wa-${kind}`, step });
    else webhookAccepted.add(1, { kind: `wa-${kind}`, step });
  } else {
    webhookRejected.add(1, { kind: `wa-${kind}`, status: String(res.status), step });
  }
  businessErrors.add(res.status !== 200, { step });
  return res;
}

const nowSec = () => String(Math.floor(Date.now() / 1000));
const uniq = () => `wamid.LT${__VU}.${__ITER || 0}.${Math.floor(Math.random() * 1e9)}`;

/** Delivery receipt — DB-only in the worker. `duplicate` re-sends the same body. */
export function waStatus(step, duplicate) {
  if (!ACCOUNTS.length || !SECRET) return null;
  const acc = ACCOUNTS[(__VU * 7919 + (__ITER || 0)) % ACCOUNTS.length];
  const body = envelope(acc.phoneNumberId, {
    statuses: [{ id: uniq(), status: 'delivered', timestamp: nowSec(), recipient_id: '966500000000' }],
  });
  const res = post(body, step, 'status');
  if (duplicate) post(body, step, 'status-dup');
  return res;
}

/** Inbound text message (LT_WA_MESSAGES=true only; see the safety note above). */
export function waMessage(step) {
  if (!MESSAGES || !ACCOUNTS.length || !SECRET) return null;
  const acc = ACCOUNTS[(__VU * 7919 + (__ITER || 0)) % ACCOUNTS.length];
  const body = envelope(acc.phoneNumberId, {
    contacts: [{ profile: { name: 'LT' }, wa_id: '966500000000' }],
    messages: [{ from: '966500000000', id: uniq(), timestamp: nowSec(), type: 'text', text: { body: 'hello' } }],
  });
  return post(body, step, 'message');
}
