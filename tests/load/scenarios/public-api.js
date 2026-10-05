/**
 * PUBLIC + API-KEY SURFACE — everything that is not a logged-in staff session.
 *
 *   discovery    public city/clinic discovery (the pre-campaign flow)
 *   funnel       the deterministic public booking funnel (session -> ... -> slot)
 *   marketplace  the 8 new marketplace routes; set LT_MARKETPLACE_KEY to ALSO measure
 *                the per-key+visitor throttle path (1 uncached api_keys lookup/request)
 *   guest        guest session minting incl. `fresh:true` (an ai_conversations row each)
 *   partner      API-key reads / upserts / signed inbound webhook (+ duplicate delivery)
 *   badkeys      invalid, malformed and missing keys (must be 401, never 5xx)
 *   ratelimit    ONE key hammered past its 120/min bucket: expects clean 429s
 *
 * Tenant isolation under high concurrency is verified two ways: the in-flight probe
 * (flows/isolation.js, run by the persona engine) and the partner key's own tenant —
 * `partner:appointments` responses are checked to contain only that key's records by
 * lab/verify-integrity.mjs afterwards (k6 cannot see other tenants' ids).
 *
 * Rates are OFFERED loads (open model). Production throttles are 30/60 per minute per
 * IP on these routes, so the capacity run lifts them (NODE_ENV=test) and a separate
 * run keeps them ON (LT_ALLOW_429=true) to measure 429 behaviour — both are labelled.
 */
import http from 'k6/http';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { publicDiscovery, bookingFunnel, bookingConfirm } from '../flows/booking.js';
import { marketplaceBrowse } from '../flows/marketplace.js';
import { partnerReads, partnerWrites, partnerInbound } from '../flows/partner.js';
import { BASE } from '../helpers/auth.js';
import { observe, partnerRateLimited } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, arrival, startAt } from '../config/kit.js';
import { pack } from '../helpers/sessions.js';

const PARTS = str('LT_PUBLIC_PARTS', 'discovery,funnel,marketplace,guest,partner,badkeys,ratelimit').split(',');
const DUR = str('LT_DURATION', '3m');
const GAP = secs(str('LT_GAP', '30s'));
const KEYS = pack('partner');

const DEFS = {
  discovery: () => arrival('discovery', num('LT_DISCOVERY_RATE', 100), DUR, { part: 'discovery' }),
  funnel: () => arrival('funnel', num('LT_FUNNEL_RATE', 30), DUR, { part: 'funnel' }),
  marketplace: () => arrival('marketplace', num('LT_MKT_RATE', 40), DUR, { part: 'marketplace' }),
  guest: () => arrival('guest', num('LT_GUEST_RATE', 20), DUR, { part: 'guest' }),
  partner: () => arrival('partner', num('LT_PARTNER_RATE', 15), DUR, { part: 'partner' }),
  badkeys: () => arrival('badkeys', num('LT_BADKEY_RATE', 10), '60s', { part: 'badkeys' }),
  ratelimit: () => arrival('ratelimit', num('LT_RATELIMIT_RATE', 5), '60s', { part: 'ratelimit' }),
};
const LEN = { badkeys: 60, ratelimit: 60 };

const scenarios = {};
let t = 0;
for (const p of PARTS) {
  if (!DEFS[p]) continue;
  scenarios[p] = startAt(DEFS[p](), t);
  t += (LEN[p] || secs(DUR)) + GAP;
}

export const options = { setupTimeout: '120s', scenarios, thresholds: steadyThresholds() };
export function setup() { return campaignSetup('public-api', { sessions: false }); }

export function discovery() { publicDiscovery('steady'); }
export function funnel() {
  const ctx = bookingFunnel('steady');
  if (__ENV.BOOKING_CONFIRM === 'true') bookingConfirm(ctx, 'steady');
}
export function marketplace() { marketplaceBrowse('steady'); }
export function guest() {
  const res = http.post(`${BASE}/api/v1/public/booking/session`, JSON.stringify({ fresh: true }), {
    headers: { 'Content-Type': 'application/json' }, tags: { step: 'steady', name: 'booking/session-fresh' },
  });
  observe(res, 'public:booking:session', 'steady');
  businessErrors.add(res.status !== 200 && res.status !== 201, { step: 'steady' });
}
export function partner() {
  const r = Math.random();
  if (r < 0.5) partnerReads('steady');
  else if (r < 0.8) partnerWrites('steady');
  else partnerInbound('steady', Math.random() < 0.25);
}
export function badkeys() {
  const variants = [
    { 'X-API-Key': 'zt_notakey_0000000000000000000000000000' },
    { 'X-API-Key': 'x' },
    { Authorization: 'ApiKey malformed' },
    {},
  ];
  const h = variants[(__ITER || 0) % variants.length];
  const res = http.get(`${BASE}/api/v1/integrations/me`, {
    headers: h, tags: { step: 'steady', name: 'partner/badkey' }, responseCallback: http.expectedStatuses(401, 403, 429),
  });
  observe(res, 'partner:me', 'steady');
  businessErrors.add(res.status >= 500, { step: 'steady' }); // must be 401/403, NEVER 5xx
}
export function ratelimit() {
  if (!KEYS.length) return;
  const k = KEYS[0];
  // One key, many calls per second: the Redis bucket (default 120/min) must answer 429, not 5xx.
  const res = http.batch([1, 2, 3, 4, 5, 6].map(() => ['GET', `${BASE}/api/v1/integrations/me`, null, {
    headers: { 'X-API-Key': k.apiKey }, responseCallback: http.expectedStatuses(200, 429), tags: { name: 'partner/ratelimit' },
  }]));
  for (const r of res) {
    observe(r, 'partner:me', 'steady');
    if (r.status === 429) partnerRateLimited.add(1, { step: 'steady' });
    businessErrors.add(r.status >= 500, { step: 'steady' });
  }
}

export const handleSummary = makeSummary({ scenario: 'public-api', parts: PARTS });
