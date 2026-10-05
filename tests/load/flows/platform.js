/**
 * Platform-admin (SUPER_ADMIN) read characterisation. NOT a load class: these are
 * a handful of staff, so this runs at 1-3 VUs to MEASURE per-call cost and pool
 * usage, not to scale. Known shapes:
 *  - finance/kpis: up to 7 concurrent queries (7 pool connections for ONE call);
 *  - finance/metrics/payments: up to 10 concurrent queries;
 *  - finance/transactions: COUNT(DISTINCT) over 5 joins + 2 correlated subqueries
 *    per row, `search` is an unindexed %term% ILIKE;
 *  - sales/overview + employees: aggregates over every assignment and invoice.
 * A super-admin has no tenant; its session comes from lab/mint-sessions.mjs
 * (role `super_admin`).
 */
import http from 'k6/http';
import { BASE, authGet } from '../helpers/auth.js';
import { observe } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';

function period() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function platformReads(session, step) {
  const p = authGet(session, { step });
  const res = http.batch([
    ['GET', `${BASE}/api/v1/platform/finance/kpis`, null, p],
    ['GET', `${BASE}/api/v1/platform/finance/transactions?page=1&limit=20`, null, p],
    ['GET', `${BASE}/api/v1/platform/finance/subscription-invoices?page=1&limit=20`, null, p],
    ['GET', `${BASE}/api/v1/platform/sales/overview?period=${period()}`, null, p],
    ['GET', `${BASE}/api/v1/platform/sales/employees?page=1&limit=20`, null, p],
  ]);
  const names = ['platform:finance:kpis', 'platform:finance:transactions', 'platform:finance:invoices',
    'platform:sales:overview', 'platform:sales:employees'];
  res.forEach((r, i) => observe(r, names[i], step));
  businessErrors.add(res.some((r) => r.status >= 500), { step });
  return res;
}
