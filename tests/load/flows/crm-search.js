/**
 * CRM search at campaign scale: highly SELECTIVE vs BROAD queries, deep pagination.
 *
 * `crm/customers/search` ORs ILIKE '%q%' across full_name / email / phone /
 * national_id and hydrates tags. Indexes: btree (tenant,phone|email|national_id|
 * created_at) only — there is NO trigram index on customers (gin_trgm_ops exists
 * only on audit_logs and users), so every `%q%` is a per-tenant scan whose cost
 * scales with the tenant's customer count. That is the point of this flow: compare
 * the SAME query on small / normal / large / hot tenants.
 *
 * Query shapes assume the campaign seeder's deterministic customers
 * (lab/seed-campaign.mjs): full_name "<First> <Last> C<t>-<n>", phone
 * "+9665<ttt><nnnnn>", email "cust.<t>.<n>@lab.test", with t = tenant index.
 *
 * KINDS (weights are a stated modelling assumption, not measured):
 *   code    35  exactly one row       q=C<t>-<n>
 *   email   15  one row               q=cust.<t>.<n>@
 *   phone   15  one row               q=+9665<ttt><nnnnn>
 *   prefix  10  a tenant-sized set    q=+9665<ttt>
 *   name    15  ~10% of the tenant    q=<First>
 *   broad   10  matches almost all    q=a
 * `deep` walks pages 1..20 of a broad query (offset pagination: cost grows with page).
 */
import http from 'k6/http';
import { BASE, authGet } from '../helpers/auth.js';
import { observe } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';

const FIRST = ['Ahmed', 'Mohammed', 'Sara', 'Ali', 'Fatima', 'Omar', 'Layla', 'Khalid', 'Noor', 'Yusuf'];
const KINDS = [['code', 35], ['email', 15], ['phone', 15], ['prefix', 10], ['name', 15], ['broad', 10]];
const TABLE = [];
for (const [k, w] of KINDS) for (let i = 0; i < w; i++) TABLE.push(k);

const pad = (n, w) => String(n).padStart(w, '0');

function query(session, kind, r) {
  const t = session.tenantIndex === undefined ? 0 : session.tenantIndex;
  const count = session.customerCount || 400;
  const n = Math.floor(r * count);
  switch (kind) {
    case 'code': return { q: `C${t}-${n}`, endpoint: 'crm:search:code' };
    case 'email': return { q: `cust.${t}.${n}@`, endpoint: 'crm:search:email' };
    case 'phone': return { q: `+9665${pad(t, 3)}${pad(n, 5)}`, endpoint: 'crm:search:phone' };
    case 'prefix': return { q: `+9665${pad(t, 3)}`, endpoint: 'crm:search:prefix' };
    case 'name': return { q: FIRST[Math.floor(r * 1000) % FIRST.length], endpoint: 'crm:search:name' };
    default: return { q: 'a', endpoint: 'crm:search:broad' };
  }
}

/** One search of a (weighted-random or forced) kind; asserts the page envelope. */
export function crmSearchKind(session, step, forcedKind) {
  const r = Math.random();
  const kind = forcedKind || TABLE[Math.floor(Math.random() * TABLE.length)];
  const { q, endpoint } = query(session, kind, r);
  const res = http.get(`${BASE}/api/v1/crm/customers/search?q=${encodeURIComponent(q)}&page=1&limit=20`,
    authGet(session, { step }));
  observe(res, endpoint, step);
  let ok = res.status === 200;
  if (ok) { try { const b = res.json(); ok = Array.isArray(b.data) && typeof b.total === 'number'; } catch (e) { ok = false; } }
  businessErrors.add(!ok, { step });
  return res;
}

/** Offset pagination on a broad query: page 1..20, cost grows with the offset. */
export function crmDeepPage(session, step) {
  const page = 1 + ((__ITER || 0) % 20);
  const res = http.get(`${BASE}/api/v1/crm/customers/search?q=a&page=${page}&limit=20`, authGet(session, { step }));
  observe(res, 'crm:search:deep', step);
  businessErrors.add(res.status !== 200, { step });
  return res;
}
