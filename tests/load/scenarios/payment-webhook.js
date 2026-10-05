/**
 * PAYMENT WORKLOAD against the LAB TAP STUB (lab/tap-stub.mjs) — no real provider,
 * no real money, no real card, ever.
 *
 *   resolve       GET  public pay link
 *   checkout      POST public checkout (creates a charge on the stub)
 *   race          N VUs ALL checkout the SAME link concurrently — the hypothesised
 *                 double-charge race (public-payment.service.ts:257-267): the stub counts
 *                 `POST /v2/charges` per booking; > 1 is a defect to REPORT, not fix
 *   return        POST public return (confirms a PENDING payment against the stub)
 *   webhook       fresh signed Tap webhooks (CAPTURED)
 *   webhook-dup   the SAME webhook delivered 4x concurrently: exactly 1 accepted, 3
 *                 deduplicated; ONE payments.outcome outbox row (asserted in SQL afterwards)
 *   billing       subscription-invoice checkout as the owner
 *   refund        idempotent refund of a PAID payment (repeat key => same refund)
 *
 * Correctness that HTTP cannot show — duplicate payments, duplicate outbox rows,
 * appointments stuck in PENDING_PAYMENT after a captured webhook, ledger totals — is
 * asserted by lab/verify-integrity.mjs after the run. Each pack row is consumed once,
 * so the rate x duration of every part must not exceed its pack (the runner checks).
 *
 * Slow / failing Tap is injected through the stub's admin API (lab/chaos.mjs tap-slow,
 * tap-fail), NOT by this script.
 */
import http from 'k6/http';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { payLinkResolve, payCheckout, payReturn, tapWebhook, billingCheckout, refund } from '../flows/pay.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, arrival, constantVus, startAt } from '../config/kit.js';

const PARTS = str('LT_PAY_PARTS', 'resolve,checkout,race,return,webhook,webhook-dup,billing,refund').split(',');
const DUR = str('LT_DURATION', '2m');
const GAP = secs(str('LT_GAP', '20s'));

const DEFS = {
  resolve: () => [arrival('resolve', num('LT_PAY_RESOLVE_RATE', 50), DUR, { part: 'resolve' }), secs(DUR)],
  checkout: () => [arrival('checkout', num('LT_PAY_CHECKOUT_RATE', 10), DUR, { part: 'checkout' }), secs(DUR)],
  race: () => [{
    executor: 'per-vu-iterations', vus: num('LT_RACE_VUS', 30), iterations: 1, maxDuration: '2m', exec: 'race', tags: { part: 'race' },
  }, 60],
  return: () => [arrival('returns', num('LT_PAY_RETURN_RATE', 10), DUR, { part: 'return' }), secs(DUR)],
  webhook: () => [arrival('webhook', num('LT_PAY_WEBHOOK_RATE', 40), DUR, { part: 'webhook' }), secs(DUR)],
  'webhook-dup': () => [arrival('webhookDup', num('LT_PAY_WEBHOOK_DUP_RATE', 10), DUR, { part: 'webhook-dup' }), secs(DUR)],
  billing: () => [arrival('billing', num('LT_PAY_BILLING_RATE', 3), DUR, { part: 'billing' }), secs(DUR)],
  refund: () => [arrival('refunds', num('LT_PAY_REFUND_RATE', 3), DUR, { part: 'refund' }), secs(DUR)],
};

const scenarios = {};
let t = 0;
for (const p of PARTS) {
  if (!DEFS[p]) continue;
  const [def, len] = DEFS[p]();
  scenarios[p.replace('-', '_')] = startAt(def, t);
  t += len + GAP;
}

export const options = { setupTimeout: '120s', scenarios, thresholds: steadyThresholds() };
export function setup() { return campaignSetup('payment-webhook'); }

export function resolve() { payLinkResolve('steady'); }
export function checkout() { payCheckout('steady'); }
// A FIXED link index: every VU fires at the same moment on the same booking.
export function race() { payCheckout('steady', num('LT_RACE_LINK_INDEX', 0)); }
export function returns() { payReturn('steady'); }
export function webhook() { tapWebhook('steady', 1); }
export function webhookDup() { tapWebhook('steady', 4); }
export function billing() { billingCheckout('steady'); }
export function refunds() { refund('steady'); }

export const handleSummary = makeSummary({ scenario: 'payment-webhook', parts: PARTS });
