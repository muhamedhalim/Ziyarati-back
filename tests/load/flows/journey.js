/**
 * Patient-journey analytics (`/analytics/journey/*`).
 *
 * Cost model (read from the service): on a cache MISS ~13-15 statements and up to
 * 8 simultaneous pool connections; on a HIT ~3 Redis operations and no SQL. The
 * cache key is tenant + range + branch + staff + service, with a single-flight
 * lease (losers poll up to 4.5 s, then recompute).
 *
 *  - warm  (default): the realistic dashboard user; same 90-day range, mostly hits.
 *  - cold  (LT_JOURNEY_COLD=true): every request uses a different `from`, so the
 *    key never repeats and every call is a miss — the worst case, and the way to
 *    expose a stampede (many VUs on ONE key with an empty cache) is to run the warm
 *    variant right after a Redis flush (see the dashboard-reporting scenario).
 *
 * `from`/`to` are strictly YYYY-MM-DD and the range may not exceed 731 days; the
 * DTO is whitelisted, so only documented params are sent.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { BASE, authGet } from '../helpers/auth.js';
import { observe } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { canAny } from '../helpers/sessions.js';

// Cold = LT_JOURNEY_COLD=true for the whole run, OR the scenario is named 'cold'
// (dashboard-reporting), so one run can mix warm and cold parts.
const GLOBAL_COLD = __ENV.LT_JOURNEY_COLD === 'true';
const isCold = () => GLOBAL_COLD || (exec.scenario && exec.scenario.name === 'cold');
const DIMENSIONS = ['branch', 'staff', 'service', 'weekday', 'hour'];

function range(spanDays) {
  const shift = isCold() ? ((__VU * 7 + (__ITER || 0)) % 300) : 0;
  const to = new Date(Date.now() - shift * 86400000);
  const from = new Date(to.getTime() - spanDays * 86400000);
  const f = (d) => d.toISOString().slice(0, 10);
  return `from=${f(from)}&to=${f(to)}`;
}

const permitted = (s) => canAny(s, 'analytics.dashboard.read', 'analytics.reports.read');

export function journeySummary(session, step) {
  if (!permitted(session)) return null;
  const res = http.get(`${BASE}/api/v1/analytics/journey/summary?${range(90)}`, authGet(session, { step }));
  observe(res, 'journey:summary', step);
  let ok = res.status === 200;
  if (ok) { try { const b = res.json(); ok = !!b.range && !!b.counts; } catch (e) { ok = false; } }
  businessErrors.add(!ok, { step });
  return res;
}

export function journeyBreakdown(session, step) {
  if (!permitted(session)) return null;
  const dim = DIMENSIONS[(__VU + (__ITER || 0)) % DIMENSIONS.length];
  const res = http.get(
    `${BASE}/api/v1/analytics/journey/breakdown?${range(90)}&dimension=${dim}&page=1&limit=20`,
    authGet(session, { step }),
  );
  observe(res, 'journey:breakdown', step);
  let ok = res.status === 200;
  if (ok) { try { ok = Array.isArray(res.json().data); } catch (e) { ok = false; } }
  businessErrors.add(!ok, { step });
  return res;
}
