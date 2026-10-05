/**
 * BUSINESS MIX — the realistic multi-persona, multi-tenant workload at a chosen
 * concurrency (default 2,000 VUs). This is the scenario the 20K stages are built
 * from; run it first at a sustainable size to establish the mix's own baseline.
 *
 * Each VU is a person (receptionist / doctor / owner / idle tab / public visitor /
 * marketplace visitor / partner system), driven by timers (30 s bell, 3 s queue
 * board, think-time actions). See flows/campaign.js for the model and its stated
 * assumptions. A small second population does REAL logins (login -> me -> refresh
 * -> logout loops) so bcrypt and refresh stay represented while the bulk of VUs use
 * offline-minted tokens.
 *
 *   LT_VUS=2000 LT_RAMP=2m LT_HOLD=10m node lab/run-campaign.mjs business-mix
 */
import { sleep } from 'k6';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { personaTick } from '../flows/campaign.js';
import { sessionLifecycle } from '../flows/authflows.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, rampVus, constantVus } from '../config/kit.js';

const VUS = num('LT_VUS', 2000);
const RAMP = str('LT_RAMP', '2m');
const HOLD = str('LT_HOLD', '10m');
const REAL_VUS = num('LT_REAL_VUS', Math.max(2, Math.round(VUS * 0.01)));
const TOTAL_S = secs(RAMP) + secs(HOLD) + 30;

export const options = {
  setupTimeout: '300s',
  scenarios: {
    mix: rampVus('mix', [
      { duration: RAMP, target: VUS }, { duration: HOLD, target: VUS }, { duration: '30s', target: 0 },
    ], { kind: 'mix' }),
    real: constantVus('real', REAL_VUS, `${TOTAL_S}s`, { kind: 'real-logins' }),
  },
  thresholds: steadyThresholds(),
};

export function setup() { return campaignSetup('business-mix'); }
export function mix() { personaTick(); }
export function real() {
  sessionLifecycle('steady', 2, 20);
  sleep(5);
}
export const handleSummary = makeSummary({ scenario: 'business-mix', vus: VUS, realVus: REAL_VUS });
