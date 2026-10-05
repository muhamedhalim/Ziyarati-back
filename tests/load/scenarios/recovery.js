/**
 * RECOVERY — does the system come BACK after being pushed past its knee?
 *
 * One ramping population in three phases, each tagged so it is scored separately:
 *   pre       LT_PRE_VUS   (sustainable)          baseline latency
 *   surge     LT_SURGE_VUS (beyond the knee)      the overload
 *   recovery  LT_PRE_VUS   again                  must return to ~baseline
 * plus an OPEN-model `probe` (5 arrivals/s) across the whole run, so a NEW arrival's
 * latency during/after the surge is observed independent of the closed population.
 *
 * September's rule (spike.js): "recovered" = recovery p95 <= 1.5x pre p95. The merge
 * script applies the SAME rule so results compare. Also read from the lab monitor: pool
 * `waiting` returning to 0, API RSS/CPU/event-loop lag returning to baseline, Redis and
 * queue depth draining, outbox PENDING back to ~0, no worker/consumer wedged.
 *
 *   LT_PRE_VUS=1000 LT_SURGE_VUS=6000 node lab/run-campaign.mjs recovery
 */
import '../config/mode-phases.js'; // MUST be first: sets LT_MODE before buckets.js reads it
import { sleep } from 'k6';
import { pickSession } from '../helpers/sessions.js';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { personaTick } from '../flows/campaign.js';
import { appointmentsPageView } from '../flows/appointments.js';
import { dashboardPageView } from '../flows/dashboard.js';
import { p0Guard } from '../config/campaign-thresholds.js';
import { num, rampVus, arrival } from '../config/kit.js';

const PRE = num('LT_PRE_VUS', 1000);
const SURGE = num('LT_SURGE_VUS', 6000);
const PRE_S = num('LT_PRE_S', 180);
const SURGE_S = num('LT_SURGE_S', 150);
const POST_S = num('LT_POST_S', 300);
// Phase boundaries must match LT_PHASES (flows/campaign.js stepNow). Ramps are inside the phase.
__ENV.LT_PHASES = __ENV.LT_PHASES || `pre:${PRE_S},surge:${SURGE_S},recovery:${POST_S}`;

export const options = {
  setupTimeout: '300s',
  scenarios: {
    population: rampVus('population', [
      { duration: '60s', target: PRE },
      { duration: `${PRE_S - 60}s`, target: PRE },
      { duration: '30s', target: SURGE },
      { duration: `${SURGE_S - 30}s`, target: SURGE },
      { duration: '30s', target: PRE },
      { duration: `${POST_S - 30}s`, target: PRE },
      { duration: '30s', target: 0 },
    ], { kind: 'recovery' }),
    probe: arrival('probe', num('LT_PROBE_RATE', 5), `${PRE_S + SURGE_S + POST_S + 30}s`, { kind: 'probe' },
      { maxVUs: 300, preAllocatedVUs: 50 }),
  },
  thresholds: p0Guard(),
};

export function setup() { return campaignSetup('recovery'); }
export function population() { personaTick(); }
export function probe() {
  const s = pickSession(__VU, ['receptionist', 'manager'], 0);
  if (!s) { sleep(1); return; }
  appointmentsPageView(s, 'probe');
  dashboardPageView(s, 'probe');
}

export const handleSummary = makeSummary({ scenario: 'recovery', pre: PRE, surge: SURGE, preS: PRE_S, surgeS: SURGE_S, postS: POST_S });
