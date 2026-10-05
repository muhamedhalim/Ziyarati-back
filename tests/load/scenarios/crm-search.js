/**
 * CRM SEARCH + activity/audit search — selective vs broad, small vs large tenants.
 *
 *   mixed       the weighted realistic distribution (flows/crm-search.js)
 *   selective   only exact-match lookups (code/email/phone)
 *   broad       only broad / prefix / one-character scans (the expensive tail)
 *   deep        offset pagination, pages 1..20
 *   activity    activity-log + audit-log search (4 of 7 ILIKE arms have trigram indexes)
 *
 * To compare tenant classes run the SAME part with LT_HOT_SHARE=0 (spread across all
 * tenants) and LT_HOT_SHARE=1 (everyone on the hot tenant) and diff the per-endpoint
 * histograms: a query whose latency grows with tenant size is the finding.
 */
import { sleep } from 'k6';
import { pickSession } from '../helpers/sessions.js';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { crmSearchKind, crmDeepPage } from '../flows/crm-search.js';
import { activitySearch, activityPageView } from '../flows/workspace.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, constantVus, startAt } from '../config/kit.js';

const PARTS = str('LT_CRM_PARTS', 'mixed,selective,broad,deep,activity').split(',');
const DUR = str('LT_DURATION', '3m');
const GAP = secs(str('LT_GAP', '30s'));
const VUS = num('LT_VUS', 300);
const HOT = num('LT_HOT_SHARE', 0);
const THINK = num('LT_THINK_S', 1);

const DEFS = {
  mixed: () => constantVus('mixed', VUS, DUR, { part: 'mixed' }),
  selective: () => constantVus('selective', VUS, DUR, { part: 'selective' }),
  broad: () => constantVus('broad', Math.max(20, Math.round(VUS / 3)), DUR, { part: 'broad' }),
  deep: () => constantVus('deep', Math.max(20, Math.round(VUS / 3)), DUR, { part: 'deep' }),
  activity: () => constantVus('activity', Math.max(20, Math.round(VUS / 3)), DUR, { part: 'activity' }),
};
const scenarios = {};
let t = 0;
for (const p of PARTS) {
  if (!DEFS[p]) continue;
  scenarios[p] = startAt(DEFS[p](), t);
  t += secs(DUR) + GAP;
}

export const options = { setupTimeout: '300s', scenarios, thresholds: steadyThresholds() };
export function setup() { return campaignSetup('crm-search'); }

const staff = () => pickSession(__VU, ['receptionist', 'manager', 'owner'], HOT);
const owner = () => pickSession(__VU, ['owner', 'manager'], HOT);

export function mixed() { const s = staff(); if (s) crmSearchKind(s, 'steady'); sleep(THINK); }
export function selective() {
  const s = staff();
  if (s) crmSearchKind(s, 'steady', ['code', 'email', 'phone'][(__ITER || 0) % 3]);
  sleep(THINK);
}
export function broad() {
  const s = staff();
  if (s) crmSearchKind(s, 'steady', ['broad', 'prefix', 'name'][(__ITER || 0) % 3]);
  sleep(THINK);
}
export function deep() { const s = staff(); if (s) crmDeepPage(s, 'steady'); sleep(THINK); }
export function activity() {
  const s = owner();
  if (!s) return;
  if (Math.random() < 0.5) activitySearch(s, 'steady'); else activityPageView(s, 'steady');
  sleep(THINK);
}

export const handleSummary = makeSummary({ scenario: 'crm-search', parts: PARTS });
