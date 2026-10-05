/**
 * 20K STRESS LADDER — the headline scenario. Persona-driven VUs (flows/campaign.js)
 * ramp through LT_LEVELS (default 100,500,1000,2500,5000,10000,15000,20000; append 25000
 * for the optional beyond-20K stage ONLY if 20K was stable), holding each level so it can
 * be scored on its HOLD window alone (requests are tagged `L<level>`, ramps `ramp`).
 *
 * WHAT THIS DOES AND DOES NOT CLAIM.
 *  - 20,000 VUs is CONCURRENCY the generator held, not "20K users supported". Every
 *    report separates: VUs, achieved req/s and in-flight requests (VUs x latency / cycle).
 *  - Offered req/s depends on the THINK model: LT_THINK_MS=15000 (realistic, default) vs
 *    3000 (the September closed-loop model). It is printed with every number.
 *  - A closed model slows down as the system slows (coordinated omission). The parallel
 *    `probe` scenario is OPEN (constant-arrival-rate 5/s of fresh requests tagged
 *    `probe`), so its latency is what a NEW arrival experiences at that moment and doubles
 *    as the recovery probe.
 *  - One generator cannot hold 20K connections on this host (16,384 ephemeral ports per
 *    source IP/destination). The runner splits VUs across N generators with k6 execution
 *    segments; per-process percentiles are NOT the campaign's, so lab/merge-summaries.mjs
 *    derives them from the summed latency-bucket counters.
 *
 * Thresholds: ONLY the P0 isolation guard (abort on the first cross-tenant read). The
 * ladder drives past the knee on purpose, so latency/error thresholds would fail by design.
 */
import '../config/mode-ladder.js'; // MUST be first: sets LT_MODE before buckets.js reads it
import { sleep } from 'k6';
import { pickSession } from '../helpers/sessions.js';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { personaTick, ladderStages, LEVELS, RAMP, HOLD } from '../flows/campaign.js';
import { appointmentsPageView } from '../flows/appointments.js';
import { dashboardPageView } from '../flows/dashboard.js';
import { p0Guard } from '../config/campaign-thresholds.js';
import { num, secs, rampVus, arrival } from '../config/kit.js';

const TOTAL_S = LEVELS.length * (secs(RAMP) + secs(HOLD)) + 60;
const PROBE_RATE = num('LT_PROBE_RATE', 5);

export const options = {
  setupTimeout: '300s',
  // 20K VU inits are slow; never let k6's own default cut the run before it starts.
  scenarios: {
    ladder: rampVus('ladder', ladderStages().concat([{ duration: '60s', target: 0 }]), { kind: 'ladder' }),
    probe: arrival('probe', PROBE_RATE, `${TOTAL_S}s`, { kind: 'probe' }, { maxVUs: 300, preAllocatedVUs: 50 }),
  },
  thresholds: p0Guard(),
};

export function setup() { return campaignSetup('stress-20k'); }

export function ladder() { personaTick(); }

/** A fresh arrival every 200 ms: what a NEW user sees while the ladder is loading the system. */
export function probe() {
  const s = pickSession(__VU, ['receptionist', 'manager'], 0);
  if (!s) { sleep(1); return; }
  appointmentsPageView(s, 'probe');
  dashboardPageView(s, 'probe');
}

export const handleSummary = makeSummary({ scenario: 'stress-20k', levels: LEVELS, ramp: RAMP, hold: HOLD, totalS: TOTAL_S });
