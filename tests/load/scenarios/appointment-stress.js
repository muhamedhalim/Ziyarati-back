/**
 * APPOINTMENT STRESS — the critical write workload, at campaign scale, with
 * explicit contention modes (see flows/appt-stress.js). Select modes with
 * LT_APPT_MODES (comma list); default runs all of them back to back.
 *
 *   throughput    constant-arrival-rate booking across MANY tenants (spread slots)
 *   lifecycle     book -> reschedule -> cancel at a lower rate
 *   same-slot     N VUs, ONE (doctor, slot): expect exactly 1x201, the rest clean 409
 *   same-doctor   N VUs, one doctor, different slots
 *   hot-branch    N VUs, the HOT tenant's widest branch
 *   multi-tenant  N VUs, one tenant each, IDENTICAL slot: must not collide
 *
 * The existing 30-VU contention in appointments-write.js stays as the September
 * regression scenario; this file is the high-volume version.
 *
 * After the run: lab/verify-integrity.mjs asserts (in SQL) no overlapping
 * non-cancelled appointments per staff, <=1 row per contended slot, quota counter
 * == rows created. HTTP statuses alone prove none of that.
 */
import '../config/steps-appt.js';
import { pickSession } from '../helpers/sessions.js';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { book, lifecycle as runLifecycle } from '../flows/appt-stress.js';
import { crossTenantProbe } from '../flows/isolation.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, arrival, constantVus, startAt } from '../config/kit.js';

const MODES = str('LT_APPT_MODES', 'throughput,lifecycle,same-slot,same-doctor,hot-branch,multi-tenant').split(',');
const DUR = str('LT_DURATION', '3m');
const GAP = secs(str('LT_GAP', '30s'));
const CONTEND_VUS = num('LT_CONTEND_VUS', 500);
const ROLES = ['receptionist', 'manager'];

// mode -> [scenario definition, length in seconds]. `exec` names match the exports below.
const DEFS = {
  throughput: () => [arrival('throughput', num('LT_RATE', 50), DUR, { mode: 'throughput' }), secs(DUR)],
  lifecycle: () => [arrival('lifecycle', num('LT_LIFECYCLE_RATE', 20), DUR, { mode: 'lifecycle' }), secs(DUR)],
  'same-slot': () => [constantVus('sameSlot', CONTEND_VUS, '45s', { mode: 'same-slot' }), 45],
  'same-doctor': () => [constantVus('sameDoctor', num('LT_VUS', 200), '60s', { mode: 'same-doctor' }), 60],
  'hot-branch': () => [constantVus('hotBranch', num('LT_VUS', 200), '60s', { mode: 'hot-branch' }), 60],
  'multi-tenant': () => [constantVus('multiTenant', num('LT_VUS', 200), '45s', { mode: 'multi-tenant' }), 45],
};

const scenarios = {};
let t = 0;
for (const m of MODES) {
  if (!DEFS[m]) continue;
  const [def, len] = DEFS[m]();
  scenarios[m.replace(/-/g, '_')] = startAt(def, t);
  t += len + GAP + 30;
}

export const options = { setupTimeout: '300s', scenarios, thresholds: steadyThresholds() };

export function setup() { return campaignSetup('appointment-stress'); }

// Hot modes pin ALL VUs to the hot tenant; the others spread over every tenant.
const sess = (hot) => pickSession(__VU, ROLES, hot ? 1 : 0);

export function throughput() {
  const s = sess(false);
  if (!s) return;
  book(s, 'a_throughput', 'spread');
  if (Math.random() < 0.02) crossTenantProbe(s, 'a_throughput');
}
export function lifecycle() { const s = sess(false); if (s) runLifecycle(s, 'a_lifecycle', 'spread', 0.5, 0.5); }
export function sameSlot() { const s = sess(true); if (s) book(s, 'a_sameslot', 'same-slot'); }
export function sameDoctor() { const s = sess(true); if (s) book(s, 'a_samedoctor', 'same-doctor'); }
export function hotBranch() { const s = sess(true); if (s) book(s, 'a_hotbranch', 'hot-branch'); }
export function multiTenant() { const s = sess(false); if (s) book(s, 'a_multitenant', 'multi-tenant'); }

export const handleSummary = makeSummary({ scenario: 'appointment-stress', modes: MODES });
