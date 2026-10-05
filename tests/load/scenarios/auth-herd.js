/**
 * AUTH HERD — authentication as a load class, run in isolation so its effect on
 * CPU / event-loop lag / pool / Redis is attributable. Select parts with
 * LT_AUTH_SCENARIOS (comma list; default: herd,sustained,lifecycle,bad,lockout).
 *
 *   herd        N VUs log in at the SAME instant (per-vu-iterations, 1 each): the
 *               "everyone opens the app at 08:00" stampede. Native bcrypt (P1.2) has
 *               never been measured under k6; the old bcryptjs herd stalled the API
 *               for minutes.
 *   sustained   constant-arrival-rate logins (open model): the login capacity number.
 *   lifecycle   closed population: login -> me -> N refreshes -> logout, looping.
 *   bad         known-wrong-password probes on DEDICATED accounts, <=4 attempts each.
 *   lockout     deliberate lockout on its OWN accounts: attempts 1-5 = 401, then 429.
 *
 * What to read alongside (lab monitor, not k6): event-loop lag p99, API CPU, pool
 * waiting, Redis ops/s, `auth_login_protection_events_total`. The login SLO class is
 * p95 < 1,000 ms (thresholds.js) — it is a reporting target here, since the herd is
 * meant to exceed it.
 *
 *   LT_HERD_VUS=1000 LT_LOGIN_RATE=40 node lab/run-campaign.mjs auth-herd
 */
import { sleep } from 'k6';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { login, sessionLifecycle, badLoginProbe, lockoutProbe } from '../flows/authflows.js';
import { p0Guard } from '../config/campaign-thresholds.js';
import { num, str, secs, arrival, constantVus, startAt } from '../config/kit.js';

const PARTS = str('LT_AUTH_SCENARIOS', 'herd,sustained,lifecycle,bad,lockout').split(',');
const DUR = str('LT_DURATION', '3m');
const GAP = secs(str('LT_GAP', '30s'));

const DEFS = {
  herd: () => [{
    executor: 'per-vu-iterations', vus: num('LT_HERD_VUS', 500), iterations: 1, maxDuration: '5m', exec: 'herd',
    tags: { part: 'herd' },
  }, 300],
  sustained: () => [arrival('sustained', num('LT_LOGIN_RATE', 20), DUR, { part: 'sustained' }), secs(DUR)],
  lifecycle: () => [constantVus('lifecycle', num('LT_LIFECYCLE_VUS', 200), DUR, { part: 'lifecycle' }), secs(DUR)],
  bad: () => [{
    executor: 'per-vu-iterations', vus: num('LT_BAD_VUS', 50), iterations: 4, maxDuration: '3m', exec: 'bad',
    tags: { part: 'bad' },
  }, 180],
  lockout: () => [{
    executor: 'per-vu-iterations', vus: num('LT_LOCK_VUS', 20), iterations: 1, maxDuration: '2m', exec: 'lockout',
    tags: { part: 'lockout' },
  }, 120],
};

const scenarios = {};
let t = 0;
for (const p of PARTS) {
  if (!DEFS[p]) continue;
  const [def, len] = DEFS[p]();
  scenarios[p] = startAt(def, t);
  t += len + GAP;
}

export const options = {
  setupTimeout: '120s',
  scenarios,
  // Reporting only except the P0 guard: the herd is SUPPOSED to push past the login SLO.
  thresholds: Object.assign(p0Guard(), {
    'endpoint_latency{endpoint:auth:login}': ['p(95)<600000'],
  }),
};

export function setup() { return campaignSetup('auth-herd', { sessions: false }); }

export function herd() { login('herd'); }
export function sustained() { login('sustained'); }
export function lifecycle() {
  sessionLifecycle('steady', num('LT_REFRESHES', 3), num('LT_REFRESH_GAP_S', 5));
  sleep(1);
}
export function bad() { badLoginProbe('bad'); sleep(1); }
export function lockout() { lockoutProbe('lockout'); }

export const handleSummary = makeSummary({ scenario: 'auth-herd', parts: PARTS });
