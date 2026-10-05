/**
 * Common campaign setup()/handleSummary() so each scenario file stays tiny.
 */
import exec from 'k6/execution';
import { preflight } from './guard.js';
import { sessionsArr, sessionIndex } from './sessions.js';
import { campaignSummary } from './summary.js';
import { describeModel } from '../flows/campaign.js';

/** Runs the live target guard, verifies the session pack, and returns nothing VUs need. */
export function campaignSetup(label, opts) {
  preflight();
  const need = !opts || opts.sessions !== false;
  if (need) {
    const n = sessionsArr.length;
    if (!n) exec.test.abort(`[${label}] sessions.json is missing or empty — run lab/mint-sessions.mjs first`);
    const idx = sessionIndex();
    const roles = Object.keys(idx.byRole).map((r) => `${r}=${idx.byRole[r].length}`).join(' ');
    console.log(`${label}: sessions=${n} tenants=${idx.tenantCount} roles[${roles}] hotTenant=${idx.hotTenantId ? 'yes' : 'no'}`);
  }
  return {};
}

export function makeSummary(extra) {
  return (data) => campaignSummary(data, Object.assign({ model: describeModel() }, extra || {}));
}
