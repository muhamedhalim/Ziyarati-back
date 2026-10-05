/**
 * DASHBOARD + REPORTING — the read workloads that scale with tenant size.
 *
 *   opens      many owners open the dashboard concurrently (8-request page load),
 *              warm caches: the realistic case.
 *   refresh    the same users hammering refresh (re-issue every few seconds).
 *   cold       dashboard + analytics + journey with CACHE_BUST / LT_JOURNEY_COLD:
 *              every request misses Redis, so this is the true aggregation cost.
 *   stampede   run right after a Redis flush (lab/chaos.mjs flush-cache): N VUs on
 *              ONE tenant's key with an empty cache -> single-flight behaviour.
 *   reports    activity log + analytics performance/staff (the uncached heavy one).
 *   platform   super-admin finance/sales characterisation at 2 VUs (NOT a load class).
 *
 * Needs `LT_JOURNEY_COLD=true CACHE_BUST=true` for the `cold` part (the runner sets
 * them when LT_DASH_PARTS includes cold). Query counts per request come from the
 * server's db_queries_total (lab monitor), which is how N+1 and non-linear growth
 * with tenant size are identified: compare the SAME endpoint on small vs large vs
 * hot tenants (LT_TENANT_CLASS pins VUs to one class, see sessions index).
 */
import { pickSession, sessionIndex, sessionsArr } from '../helpers/sessions.js';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { dashboardPageView, staffPerformanceReport } from '../flows/dashboard.js';
import { journeySummary, journeyBreakdown } from '../flows/journey.js';
import { activityPageView, activitySearch, notificationPoll } from '../flows/workspace.js';
import { platformReads } from '../flows/platform.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, constantVus, arrival, startAt } from '../config/kit.js';
import { sleep } from 'k6';

const PARTS = str('LT_DASH_PARTS', 'opens,refresh,cold,stampede,reports,platform').split(',');
const DUR = str('LT_DURATION', '3m');
const GAP = secs(str('LT_GAP', '30s'));
const VUS = num('LT_VUS', 500);
const HOT = num('LT_HOT_SHARE', 0);

const DEFS = {
  opens: () => [constantVus('opens', VUS, DUR, { part: 'opens' }), secs(DUR)],
  refresh: () => [constantVus('refresh', Math.max(50, Math.round(VUS / 4)), DUR, { part: 'refresh' }), secs(DUR)],
  cold: () => [arrival('cold', num('LT_COLD_RATE', 20), DUR, { part: 'cold' }), secs(DUR)],
  stampede: () => [constantVus('stampede', num('LT_STAMPEDE_VUS', 300), '60s', { part: 'stampede' }), 60],
  reports: () => [constantVus('reports', Math.max(20, Math.round(VUS / 10)), DUR, { part: 'reports' }), secs(DUR)],
  platform: () => [constantVus('platform', 2, DUR, { part: 'platform' }), secs(DUR)],
};

const scenarios = {};
let t = 0;
for (const p of PARTS) {
  if (!DEFS[p]) continue;
  const [def, len] = DEFS[p]();
  scenarios[p] = startAt(def, t);
  t += len + GAP;
}

export const options = { setupTimeout: '300s', scenarios, thresholds: steadyThresholds() };
export function setup() { return campaignSetup('dashboard-reporting'); }

const owner = () => pickSession(__VU, ['owner', 'manager'], HOT);

export function opens() { const s = owner(); if (!s) return; dashboardPageView(s, 'steady'); journeySummary(s, 'steady'); sleep(num('LT_THINK_S', 5)); }
export function refresh() { const s = owner(); if (!s) return; dashboardPageView(s, 'steady'); sleep(2); }
export function cold() { const s = owner(); if (!s) return; dashboardPageView(s, 'steady'); journeySummary(s, 'steady'); journeyBreakdown(s, 'steady'); }
export function stampede() {
  // ALL VUs on the hot tenant's owner session, identical request => identical cache key.
  const s = pickSession(__VU, ['owner'], 1);
  if (!s) return;
  journeySummary(s, 'steady');
  dashboardPageView(s, 'steady');
  sleep(1);
}
export function reports() {
  const s = owner();
  if (!s) return;
  activityPageView(s, 'steady');
  if (Math.random() < 0.4) activitySearch(s, 'steady');
  staffPerformanceReport(s, 'steady');
  notificationPoll(s, 'steady');
  sleep(2);
}
export function platform() {
  const idx = sessionIndex();
  const i = (idx.byRole.super_admin || [])[0];
  if (i === undefined) return;
  platformReads(sessionsArr[i], 'steady');
  sleep(5);
}

export const handleSummary = makeSummary({ scenario: 'dashboard-reporting', parts: PARTS });
