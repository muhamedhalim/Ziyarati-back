/**
 * CRM list and search.
 *
 * `/crm/customers/search` is the most expensive read in the workspace by query
 * shape: `q` becomes three OR'd `ILIKE '%term%'` predicates across full_name /
 * email / phone with NO trigram or full-text index on `customers` (the only
 * gin_trgm_ops indexes in the schema are on audit_logs and users). It also
 * hydrates `tags`, which pushes TypeORM into its 3-statement path.
 *
 * Two properties make it worth probing deliberately:
 *   - `q` is NOT LIKE-escaped, so `q=%` matches every row;
 *   - there is no minimum length, so `q=a` is legal and maximally expensive.
 * `CRM_PATHOLOGICAL=true` enables those variants. They are legitimate load
 * shapes any user could send today — not synthetic abuse.
 */
import http from 'k6/http';
import { BASE, authGet } from '../helpers/auth.js';
import { observe, journeyLatency } from '../helpers/metrics.js';
import { checkPagedList } from '../helpers/checks.js';

const TERMS = ['ahmed', 'mohammed', 'sara', 'ali', 'fatima', 'perf', 'customer'];

export function crmPageView(session, step) {
  const p = authGet(session, { step });
  const started = Date.now();
  const res = http.batch([
    ['GET', `${BASE}/api/v1/notifications/inbox/unread-count`, null, p],
    ['GET', `${BASE}/api/v1/crm/tags`, null, p],
    ['GET', `${BASE}/api/v1/crm/customers/search?page=1&limit=10`, null, p],
  ]);
  journeyLatency.add(Date.now() - started, { journey: 'crm', step });

  observe(res[0], 'notifications:unread', step);
  observe(res[1], 'crm:tags', step);
  observe(res[2], 'crm:search', step);
  checkPagedList(res[2], 'crm-search', { step });
  return res;
}

/** A typed search — the realistic expensive case. */
export function crmSearch(session, step) {
  const p = authGet(session, { step });
  const term = TERMS[(__VU + (__ITER || 0)) % TERMS.length];
  const res = http.get(
    `${BASE}/api/v1/crm/customers/search?q=${term}&page=1&limit=10`, p);
  observe(res, 'crm:search:term', step);
  return res;
}

/** Worst-case scan: a single character, or the LIKE wildcard itself. */
export function crmPathologicalSearch(session, step) {
  const p = authGet(session, { step });
  const term = ((__ITER || 0) % 2 === 0) ? 'a' : '%';
  const res = http.get(
    `${BASE}/api/v1/crm/customers/search?q=${encodeURIComponent(term)}&page=1&limit=10`, p);
  observe(res, 'crm:search:pathological', step);
  return res;
}

/** The plain unfiltered list — 2 SQL, no joins, index-covered. */
export function crmList(session, step) {
  const p = authGet(session, { step });
  const res = http.get(`${BASE}/api/v1/crm/customers?page=1&limit=20`, p);
  observe(res, 'crm:list', step);
  return res;
}
