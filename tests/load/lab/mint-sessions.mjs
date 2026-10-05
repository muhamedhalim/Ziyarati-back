#!/usr/bin/env node
/**
 * Builds the k6 session file and the DATABASE-derived data packs.
 *
 *   node tests/load/lab/mint-sessions.mjs [--ttl-hours 6] [--out tests/load/data/generated]
 *
 * Reads the lab database (seeded by seed-campaign.mjs), and writes into data/generated/ (gitignored):
 *   sessions.json          { meta, index, sessions[] } — one pre-authenticated session per
 *                          (tenant x staff user): offline-signed HS256 ACCESS token + CSRF value +
 *                          permissions + the tenant context the flows need (branches, doctor/branch
 *                          pairs, customer/service ids, queue pool index, probe appointment id)
 *   pack-queue.json        [{ tenantId, branchId, appts[] }]   check-in pool (CONFIRMED appointments)
 *   pack-marketplace.json  [{ clinicSlugs, doctorSlugs, specialtySlugs, serviceRoutes, cityIds }]
 *   pack-wa.json           [{ phoneNumberId }]                  tokenless WhatsApp accounts
 *   pack-auth.json / pack-auth-bad.json / pack-auth-lock.json   [{ email }]
 *   services.xlsx          a small valid services-import file (binary)
 * The API-driven packs (partner keys, pay links, webhooks, invoices) are built by
 * build-packs.mjs, which needs the API running.
 *
 * WHY OFFLINE TOKENS. 20,000 VUs x bcrypt-12 logins would make every scenario a login
 * benchmark. JwtStrategy only verifies the signature + expiry and then RE-READS the user, so a token
 * signed with the lab's JWT_ACCESS_SECRET exercises the real guard chain (principal join, permissions,
 * CSRF double-submit, tenant/feature/subscription gates). Real logins are exercised separately
 * (auth-herd, and the `real` population inside business-mix / soak-20k). The payload matches
 * what AuthService signs: { sub, tenantId, type:'access' } — HS256, no iss/aud/jti — plus `exp`.
 * The lab secret never leaves lab/run/lab.json; no token is printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { loadLab, LAB_DIR, RUN_DIR } from './make-lab-env.mjs';

const REPO = path.resolve(LAB_DIR, '..', '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = path.resolve(opt('out', path.join(LAB_DIR, '..', 'data', 'generated')));
const TTL_H = Number(opt('ttl-hours', 6));
const DOMAIN = 'c20k.lab.test';
const lab = loadLab();

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const env = Object.fromEntries(fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const pg = new Client({ connectionString: env.DATABASE_URL, application_name: 'lt-mint' });
await pg.connect();
fs.mkdirSync(OUT, { recursive: true });
const q = async (sql, params) => (await pg.query(sql, params)).rows;
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data));

const ROLE = { 'Clinic Owner': 'owner', 'Operations Manager': 'manager', 'Branch Manager': 'branch_manager', Receptionist: 'receptionist', Doctor: 'doctor', Nurse: 'nurse', 'Super Admin': 'super_admin' };
const KEEP_PER_TENANT = { owner: 1, manager: 1, receptionist: 2, doctor: 2, nurse: 1 };

// ------------------------------------------------------------------ tenants + classes
const tenantRows = await q(`select t.id, t.slug, c.idx, c.class from tenants t join lt_lab_tenant_class c on c.tenant_id = t.id order by c.idx`);
if (!tenantRows.length) { console.error('no lab tenants found — run seed-campaign.mjs first'); process.exit(1); }
const tenant = new Map(tenantRows.map((t) => [t.id, t]));
const hot = tenantRows.find((t) => t.class === 'hot');

// role -> permission slugs (system roles)
const perms = new Map();
for (const r of await q(`select r.name, array_agg(p.slug order by p.slug) slugs from roles r
    join role_permissions rp on rp."roleId" = r.id join permissions p on p.id = rp."permissionId"
   where r."tenantId" is null group by r.name`)) perms.set(r.name, r.slugs);

// ------------------------------------------------------------------ per-tenant context (few set-based queries)
const branches = new Map(); for (const r of await q(`select id, "tenantId" t from branches where deleted_at is null and is_active order by created_at, id`)) (branches.get(r.t) || branches.set(r.t, []).get(r.t)).push(r.id);
const pairsRaw = await q(`select sp."tenantId" t, bu."branchId" b, sp.id s from staff_profiles sp join branch_users bu on bu."userId" = sp.user_id where sp.deleted_at is null order by sp."tenantId", bu."branchId", sp.id`);
const pairs = new Map(); const staffIds = new Map();
for (const r of pairsRaw) {
  const list = pairs.get(r.t) || pairs.set(r.t, new Map()).get(r.t);
  (list.get(r.b) || list.set(r.b, []).get(r.b)).push(r.s);
  (staffIds.get(r.t) || staffIds.set(r.t, []).get(r.t)).push(r.s);
}
const services = new Map(); for (const r of await q(`select id, "tenantId" t from services where is_active order by id`)) (services.get(r.t) || services.set(r.t, []).get(r.t)).push(r.id);
const custCount = new Map(); for (const r of await q(`select "tenantId" t, count(*)::int c from customers group by 1`)) custCount.set(r.t, r.c);
const customers = new Map();
for (const t of tenantRows) customers.set(t.id, (await q(`select id from customers where "tenantId" = $1 and is_active order by id limit 20`, [t.id])).map((r) => r.id));
const probe = new Map();
for (const t of tenantRows) { const r = await q(`select id from appointments where "tenantId" = $1 limit 1`, [t.id]); if (r[0]) probe.set(t.id, r[0].id); }
const ownStaff = new Map(); for (const r of await q(`select user_id u, id s from staff_profiles where deleted_at is null`)) ownStaff.set(r.u, r.s);

// ------------------------------------------------------------------ queue pool pack
const queueRows = await q(`select "tenantId" t, "branchId" b, array_agg(id order by start_at) a from appointments
   where notes = 'lt-queue-pool' and status = 'CONFIRMED' group by 1, 2 order by 1, count(*) desc`);
const queuePack = []; const queueIdx = new Map();
for (const r of queueRows) { if (queueIdx.has(r.t)) continue; queueIdx.set(r.t, queuePack.length); queuePack.push({ tenantId: r.t, branchId: r.b, appts: r.a }); }

// ------------------------------------------------------------------ users -> sessions
const users = await q(`select u.id, u.email, u."tenantId" t, r.name role_name from users u
   join user_roles ur on ur."userId" = u.id join roles r on r.id = ur."roleId"
  where u.is_active and u.deleted_at is null
    and ((u.email like $1 and u.email like 'perf.%') or u.email = 'lab.superadmin@${DOMAIN}')
  order by u."tenantId" nulls first, r.name, u.email`, [`%@${DOMAIN}`]);

const exp = Math.floor(Date.now() / 1000) + TTL_H * 3600;
const sessions = []; const taken = new Map();
const index = { count: 0, tenantCount: 0, byRole: {}, hotByRole: {}, ownerByTenant: {}, hotTenantId: hot ? hot.id : null };
for (const u of users) {
  const role = ROLE[u.role_name]; if (!role) continue;
  if (u.t) {
    const key = `${u.t}:${role}`; const n = (taken.get(key) || 0) + 1;
    if (n > (KEEP_PER_TENANT[role] || 0)) continue;
    taken.set(key, n);
  }
  const tn = u.t ? tenant.get(u.t) : null;
  if (u.t && !tn) continue; // user of a tenant that is not a lab tenant
  const tp = u.t ? pairs.get(u.t) : null;
  const token = jwt.sign({ sub: u.id, tenantId: u.t || null, type: 'access', exp }, lab.secrets.jwtAccess, { algorithm: 'HS256' });
  const s = {
    userId: u.id, email: u.email, role, tenantId: u.t || null,
    tenantIndex: tn ? tn.idx : null, class: tn ? tn.class : null,
    permissions: perms.get(u.role_name) || [],
    access: token, csrf: crypto.randomBytes(32).toString('hex'),
    branchIds: u.t ? (branches.get(u.t) || []) : [],
    pairs: tp ? [...tp.entries()].map(([branchId, ids]) => ({ branchId, staffIds: ids })) : [],
    staffIds: u.t ? (staffIds.get(u.t) || []) : [],
    customerIds: u.t ? (customers.get(u.t) || []) : [], customerCount: u.t ? (custCount.get(u.t) || 0) : 0,
    serviceIds: u.t ? (services.get(u.t) || []) : [],
    queueIdx: u.t && queueIdx.has(u.t) ? queueIdx.get(u.t) : -1,
    probeAppointmentId: u.t ? (probe.get(u.t) || null) : null,
    ownStaffId: ownStaff.get(u.id) || null,
  };
  const i = sessions.push(s) - 1;
  (index.byRole[role] = index.byRole[role] || []).push(i);
  if (tn && tn.class === 'hot') (index.hotByRole[role] = index.hotByRole[role] || []).push(i);
  if (role === 'owner' && u.t) index.ownerByTenant[u.t] = i;
}
index.count = sessions.length;
index.tenantCount = new Set(sessions.map((s) => s.tenantId).filter(Boolean)).size;
write('sessions.json', { meta: { schema: 'lt-sessions/1', createdAt: new Date().toISOString(), ttlHours: TTL_H, lab: lab.db.name, tokens: 'offline-signed HS256 access tokens (lab secret)' }, index, sessions });

// ------------------------------------------------------------------ database-derived packs
write('pack-queue.json', queuePack);
const eligible = `t.approval_status = 'APPROVED' and t.is_active and t.deleted_at is null and ts.public_booking_enabled`;
write('pack-marketplace.json', [{
  clinicSlugs: (await q(`select t.slug from tenants t join tenant_settings ts on ts.tenant_id = t.id where ${eligible} order by t.slug limit 300`)).map((r) => r.slug),
  doctorSlugs: (await q(`select sp.public_slug s from staff_profiles sp join tenants t on t.id = sp."tenantId" join tenant_settings ts on ts.tenant_id = t.id
                         where ${eligible} and sp.is_available_for_booking and sp.deleted_at is null order by sp.public_slug limit 600`)).map((r) => r.s),
  specialtySlugs: (await q(`select slug from specialties order by slug limit 60`)).map((r) => r.slug),
  serviceRoutes: (await q(`select t.slug c, s.public_slug s from services s join tenants t on t.id = s."tenantId" join tenant_settings ts on ts.tenant_id = t.id
                           where ${eligible} and s.is_active order by t.slug, s.public_slug limit 600`)).map((r) => ({ c: r.c, s: r.s })),
  cityIds: (await q(`select id from cities order by id`)).map((r) => r.id),
}]);
write('pack-wa.json', (await q(`select phone_number_id from whatsapp_accounts where deleted_at is null and phone_number_id like 'lt-pn-%' order by phone_number_id`)).map((r) => ({ phoneNumberId: r.phone_number_id })));
const emails = async (like, limit) => (await q(`select email from users where email like $1 and is_active order by email limit $2`, [like, limit])).map((r) => ({ email: r.email }));
write('pack-auth.json', (await q(`select u.email from users u join user_roles ur on ur."userId" = u.id join roles r on r.id = ur."roleId"
   where u.email like $1 and u.is_active and r.name in ('Receptionist','Clinic Owner','Doctor') order by u.email limit 2000`, [`perf.%@${DOMAIN}`])).map((r) => ({ email: r.email })));
write('pack-auth-bad.json', await emails(`auth.bad.%@${DOMAIN}`, 1000));
write('pack-auth-lock.json', await emails(`auth.lock.%@${DOMAIN}`, 1000));

// ------------------------------------------------------------------ a small valid services-import xlsx
try {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Services');
  ws.addRow(['name', 'duration (minutes)', 'description', 'pricing type', 'price', 'category', 'active']);
  for (let i = 0; i < 100; i++) ws.addRow([`LT Import Service ${i}`, 15 + (i % 4) * 15, 'load test import row', 'FIXED', 50 + i, '', 'yes']);
  fs.writeFileSync(path.join(OUT, 'services.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()));
} catch (e) { console.warn(`services.xlsx not written: ${e.message}`); }

await pg.end();
const byRole = Object.fromEntries(Object.entries(index.byRole).map(([k, v]) => [k, v.length]));
console.log(`sessions: ${sessions.length} over ${index.tenantCount} tenants  roles=${JSON.stringify(byRole)}  hot tenant sessions=${Object.values(index.hotByRole).flat().length}`);
console.log(`packs: queue=${queuePack.length} tenants (${queuePack.reduce((a, e) => a + e.appts.length, 0)} appointments)  wa=${fs.existsSync(path.join(OUT, 'pack-wa.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'pack-wa.json'), 'utf8')).length : 0}`);
console.log(`written to ${path.relative(REPO, OUT)} (gitignored). Tokens expire ${new Date(exp * 1000).toISOString()}; re-run to refresh.`);
