/**
 * HIGH-LOAD SOAK — the persona mix held at a HIGH BUT SUSTAINABLE level for hours.
 *
 * LT_SOAK_VUS must be chosen from the stress results (a level classed healthy/degraded-
 * but-stable, with headroom) — there is deliberately no 20,000 default: soaking at the
 * collapse point only measures the collapse. Default 2,000 is a placeholder.
 *
 * What a soak is FOR: drift. Requests are tagged by fixed windows (w0, w1, ... default
 * 10 min each) so p95/p99, 5xx, DB pool waiting, API RSS/heap, Redis memory, queue depth,
 * outbox backlog and dead tuples can be plotted over time; a flat line is the pass.
 *
 * The September 30-minute soak failed at its RE-LOGIN HERD (36.75% errors) while showing no
 * leak. This soak therefore includes a REAL-SESSION population that logs in, refreshes at
 * the production access-token cadence (~14 min, jittered) and logs out, so a refresh/login
 * wave is part of the run. Refresh tokens are one-time-use, one jar per VU.
 *
 *   LT_SOAK_VUS=5000 LT_SOAK_DURATION=2h node lab/run-campaign.mjs soak-20k
 */
import '../config/mode-soak.js'; // MUST be first: sets LT_MODE before buckets.js reads it
import { sleep } from 'k6';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { personaTick } from '../flows/campaign.js';
import { sessionLifecycle } from '../flows/authflows.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, rampVus, constantVus } from '../config/kit.js';

const VUS = num('LT_SOAK_VUS', 2000);
const RAMP = str('LT_SOAK_RAMP', '5m');
const HOLD = str('LT_SOAK_DURATION', '2h');
const REAL_VUS = num('LT_REAL_VUS', Math.max(5, Math.round(VUS * 0.02)));
const TOTAL_S = secs(RAMP) + secs(HOLD) + 60;
const REFRESH_GAP_S = num('LT_REFRESH_GAP_S', 840);

export const options = {
  setupTimeout: '300s',
  scenarios: {
    soak: rampVus('soak', [
      { duration: RAMP, target: VUS }, { duration: HOLD, target: VUS }, { duration: '60s', target: 0 },
    ], { kind: 'soak' }),
    real: constantVus('real', REAL_VUS, `${TOTAL_S}s`, { kind: 'real-sessions' }),
  },
  thresholds: steadyThresholds(),
};

export function setup() { return campaignSetup('soak-20k'); }
export function soak() { personaTick(); }
export function real() {
  // login -> me -> 4 refreshes ~14 min apart -> logout, then a new person arrives.
  sessionLifecycle('steady', 4, REFRESH_GAP_S + Math.floor(Math.random() * 60));
  sleep(30);
}

export const handleSummary = makeSummary({ scenario: 'soak-20k', vus: VUS, realVus: REAL_VUS, duration: HOLD });
