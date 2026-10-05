/**
 * Payments: the patient pay link, the Tap webhook, billing checkout and refunds.
 * Everything talks to the LAB Tap stub (lab/tap-stub.mjs via TAP_API_BASE); no
 * real payment provider is ever contacted, and no real card or financial value
 * exists anywhere in the dataset.
 *
 * Data packs (arrays of small rows, so SharedArray access stays cheap):
 *   pack-pay-links.json        [{ token }]                               payable pay links (one-shot)
 *   pack-pay-webhooks.json     [{ chargeId, paymentId, amount, currency }]  PENDING payments awaiting a webhook
 *   pack-pay-returns.json      [{ chargeId }]                            PENDING payments for /public/payments/return
 *   pack-pay-invoices.json     [{ tenantId, invoiceId }]                 OPEN subscription invoices
 *   pack-pay-refundables.json  [{ tenantId, paymentId }]                 PAID payments
 *
 * Facts that shape the checks:
 *  - Checkout answers 200 with a `state` in {redirect, processing, paid, expired,
 *    unavailable, failed}. `processing` is a legitimate answer to a concurrent
 *    duplicate (the loser of the partial-unique-index race), so states are COUNTED,
 *    not failed. Public checkout is throttled 10/min/IP (lifted under NODE_ENV=test).
 *  - The webhook re-fetches the charge from the stub on EVERY delivery, duplicates
 *    included; the dedupe key is `tap:{chargeId}:{STATUS}`. Duplicates must answer
 *    200 `{deduplicated:true}` and produce ONE `payments.outcome` outbox row —
 *    verified after the run by lab/verify-payments.sql, not by the HTTP status.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { BASE, authWrite } from '../helpers/auth.js';
import {
  observe, payRedirect, payProcessing, payOther,
  webhookAccepted, webhookDuplicate, webhookRejected,
} from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { pack, ownerSessionOf } from '../helpers/sessions.js';
import { tapHashstring } from '../helpers/signing.js';

const LINKS = pack('pay-links');
const WEBHOOKS = pack('pay-webhooks');
const RETURNS = pack('pay-returns');
const INVOICES = pack('pay-invoices');
const REFUNDABLES = pack('pay-refundables');
const TAP_SECRET = __ENV.LT_TAP_SECRET || '';

/** A pack row unique across the whole scenario (and across generator segments). */
function nth(arr) {
  if (!arr.length) return null;
  return arr[exec.scenario.iterationInTest % arr.length];
}

const EXPECT_PUBLIC = http.expectedStatuses({ min: 200, max: 299 }, 404, 429);

export function payLinkResolve(step) {
  const row = nth(LINKS);
  if (!row) return null;
  const res = http.get(`${BASE}/api/v1/public/payments/links/${row.token}`, {
    tags: { step, name: 'pay/resolve' }, responseCallback: EXPECT_PUBLIC,
  });
  observe(res, 'pay:resolve', step);
  let ok = res.status === 200;
  if (ok) { try { ok = ['payable', 'paid', 'expired', 'unavailable'].indexOf(res.json().state) !== -1; } catch (e) { ok = false; } }
  businessErrors.add(!ok, { step });
  return res;
}

export function payCheckout(step, fixedIndex) {
  // fixedIndex pins EVERY caller to one link: the concurrent-checkout race probe.
  const row = fixedIndex === undefined ? nth(LINKS) : (LINKS.length ? LINKS[fixedIndex % LINKS.length] : null);
  if (!row) return null;
  const res = http.post(`${BASE}/api/v1/public/payments/links/${row.token}/checkout`, null, {
    tags: { step, name: 'pay/checkout' }, responseCallback: EXPECT_PUBLIC,
  });
  observe(res, 'pay:checkout', step);
  let state = 'error';
  if (res.status === 200) { try { state = res.json().state; } catch (e) { state = 'unparsable'; } }
  if (state === 'redirect') payRedirect.add(1, { step });
  else if (state === 'processing') payProcessing.add(1, { step });
  else payOther.add(1, { state, step });
  businessErrors.add(res.status !== 200, { step });
  return res;
}

export function payReturn(step) {
  const row = nth(RETURNS);
  if (!row) return null;
  const res = http.post(`${BASE}/api/v1/public/payments/return`, JSON.stringify({ chargeId: row.chargeId }), {
    headers: { 'Content-Type': 'application/json' }, tags: { step, name: 'pay/return' }, responseCallback: EXPECT_PUBLIC,
  });
  observe(res, 'pay:return', step);
  businessErrors.add(res.status !== 200, { step });
  return res;
}

function chargeBody(row) {
  return {
    id: row.chargeId,
    object: 'charge',
    status: 'CAPTURED',
    amount: row.amount,
    currency: row.currency,
    reference: { gateway: `gw_${row.chargeId}`, payment: `pay_${row.chargeId}`, transaction: row.paymentId },
    transaction: { created: String(Date.now()) },
    metadata: { udf1: row.paymentId },
  };
}

function webhookRequest(row) {
  const body = chargeBody(row);
  return ['POST', `${BASE}/api/v1/payments/webhooks/tap`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', hashstring: tapHashstring(body, TAP_SECRET) },
    tags: { name: 'pay/webhook' },
    responseCallback: http.expectedStatuses(200, 401, 503),
  }];
}

function classifyWebhook(res, step, kind) {
  if (res.status !== 200) { webhookRejected.add(1, { kind, status: String(res.status), step }); return; }
  let b = {};
  try { b = res.json(); } catch (e) { /* ignore */ }
  if (b.deduplicated) webhookDuplicate.add(1, { kind, step });
  else webhookAccepted.add(1, { kind, step, matched: String(!!b.matched) });
}

/**
 * Tap webhook. `copies` > 1 sends that many IDENTICAL deliveries concurrently
 * (http.batch) to exercise the row lock + unique-index dedupe: exactly one may be
 * `accepted`, the rest `deduplicated`.
 */
export function tapWebhook(step, copies) {
  const row = nth(WEBHOOKS);
  if (!row || !TAP_SECRET) return null;
  const n = Math.max(1, copies || 1);
  const reqs = [];
  for (let i = 0; i < n; i++) reqs.push(webhookRequest(row));
  const out = http.batch(reqs);
  for (const r of out) {
    observe(r, 'pay:webhook', step);
    classifyWebhook(r, step, n > 1 ? 'tap-dup' : 'tap');
    businessErrors.add(r.status !== 200, { step });
  }
  return out[0];
}

/** Subscription-invoice checkout, as the owner of the invoice's tenant. */
export function billingCheckout(step) {
  const row = nth(INVOICES);
  if (!row) return null;
  const session = ownerSessionOf(row.tenantId);
  if (!session) return null;
  const p = authWrite(session, { step });
  p.responseCallback = http.expectedStatuses({ min: 200, max: 299 }, 409, 422, 503);
  const res = http.post(`${BASE}/api/v1/billing/invoices/${row.invoiceId}/checkout`, null, p);
  observe(res, 'billing:checkout', step);
  businessErrors.add(res.status >= 500 && res.status !== 503, { step });
  return res;
}

/** Refund of a PAID payment, idempotent by key. A repeat must return the same refund. */
export function refund(step) {
  const row = nth(REFUNDABLES);
  if (!row) return null;
  const session = ownerSessionOf(row.tenantId);
  if (!session) return null;
  const p = authWrite(session, { step });
  p.responseCallback = http.expectedStatuses({ min: 200, max: 299 }, 404, 409, 422);
  const res = http.post(`${BASE}/api/v1/refunds`, JSON.stringify({
    paymentId: row.paymentId, amount: 1, reason: 'lt', idempotencyKey: `lt-refund-${row.paymentId}`,
  }), p);
  observe(res, 'refund:create', step);
  businessErrors.add(res.status >= 500, { step });
  return res;
}
