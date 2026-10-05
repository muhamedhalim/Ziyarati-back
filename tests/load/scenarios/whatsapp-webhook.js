/**
 * WHATSAPP WEBHOOK — synthetic, signed, multi-tenant inbound traffic.
 *
 *   status      delivery receipts (DB-only in the worker: no AI, no Meta call)
 *   status-dup  the same receipt delivered twice: second MUST be `deduplicated:true`
 *   message     inbound text (LT_WA_MESSAGES=true ONLY — see the safety note in flows/wa.js)
 *
 * Webhook RESPONSE time (this scenario, k6) and asynchronous PROCESSING time (the
 * `whatsapp-webhook` queue: depth, job latency, retries, DLQ — lab monitor) are two
 * different numbers and are reported separately. The HTTP path only verifies the
 * signature, stores a row and enqueues; with Redis down the row is stored but never
 * processed (the enqueue failure is only logged) — see chaos `redis-down`.
 *
 * Throttle: 60/min per IP in production; lifted under NODE_ENV=test for the capacity run.
 * Nothing here can reach Meta: accounts are tokenless and the API never calls Graph.
 */
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { waStatus, waMessage } from '../flows/wa.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, arrival, startAt } from '../config/kit.js';

const PARTS = str('LT_WA_PARTS', 'status,status-dup,message').split(',');
const DUR = str('LT_DURATION', '3m');
const GAP = secs(str('LT_GAP', '30s'));

const DEFS = {
  status: () => arrival('status', num('LT_WA_RATE', 100), DUR, { part: 'status' }),
  'status-dup': () => arrival('statusDup', num('LT_WA_DUP_RATE', 30), DUR, { part: 'status-dup' }),
  message: () => arrival('message', num('LT_WA_MSG_RATE', 20), DUR, { part: 'message' }),
};
const scenarios = {};
let t = 0;
for (const p of PARTS) {
  if (!DEFS[p]) continue;
  if (p === 'message' && __ENV.LT_WA_MESSAGES !== 'true') continue; // never silently enabled
  scenarios[p.replace('-', '_')] = startAt(DEFS[p](), t);
  t += secs(DUR) + GAP;
}

export const options = { setupTimeout: '120s', scenarios, thresholds: steadyThresholds() };
export function setup() { return campaignSetup('whatsapp-webhook', { sessions: false }); }

export function status() { waStatus('steady', false); }
export function statusDup() { waStatus('steady', true); }
export function message() { waMessage('steady'); }

export const handleSummary = makeSummary({ scenario: 'whatsapp-webhook', parts: PARTS });
