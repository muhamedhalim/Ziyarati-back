#!/usr/bin/env node
/**
 * Seeds the DISPOSABLE campaign dataset into the lab database (ziyarati_c20k).
 *
 *   node tests/load/lab/seed-campaign.mjs [--profile full|mini] [--contract-only] [--force]
 *
 * WHY A NEW SEEDER. The repo's perf seed (src/seed/perf-fixture.seed.ts) and tests/load/data/fixture.sql
 * predate NOT NULL `staff_profiles.public_slug` / `services.public_slug` and would fail today; they also
 * model only 5 loggable tenants. This script is written against the CURRENT migrated schema, lives in
 * tests/ (no application code touched), and is set-based SQL (a 1M-row run is minutes, not hours).
 *
 * PROFILES (counts are PARAMETERS of this campaign, not production figures — production tenant-size
 * distribution is NOT MEASURED):
 *   full  500 tenants: 1 HOT (idx 0), 4 LARGE (1-4), 25 SMALL (5-29), 470 NORMAL (30-499)
 *         ~1.07M appointments, ~265k customers, ~5.5k users, ~600k audit rows.   Estimated 3-4 GB.
 *   mini  12 tenants with the same shape and ~1% of the volume: validates every statement in seconds.
 * Run `mini` first on a fresh DB, destroy, then `full`.
 *
 * SHAPE
 *   tenant class   branches                         doctors/branch  customers  appointments
 *   hot            Solo(1 doctor) Wide(10) Main(3)   -               20,000     100,000
 *   large          10                                4               5,000      30,000
 *   normal         2 or 3                            2               400        1,800
 *   small          1                                 1               50         100
 *   per tenant users: 1 Clinic Owner, 1 Operations Manager, 2 Receptionists, 1 Nurse + doctors.
 *   everyone shares ONE bcrypt hash of the lab login password (computed once: bcrypt-12 per user
 *   would take hours). Emails are lowercase (CHECK ck_user_email_lowercase) and globally unique.
 *
 * DETERMINISTIC NAMES the k6 flows rely on (flows/crm-search.js):
 *   customer  "<First> <Last> C<t>-<n>", phone "+9665<ttt><nnnnn>", email "cust.<t>.<n>@lab.test"
 *
 * SAFETY: refuses any database that is not the lab DB; writes the `lt_lab_sentinel` row that
 * run-campaign.mjs requires; creates NO workflows, webhook endpoints, notification rules, and WhatsApp
 * accounts WITHOUT tokens (the external-effect tables stay inert). bot_enabled=false everywhere.
 *
 * Not built here (stated, not hidden): subscription/invoice/renewal/refundable packs — their semantics
 * interact with plan limits and access control and need an explicit decision first (see Phase E report).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { loadLab, LAB_DIR, RUN_DIR } from './make-lab-env.mjs';

const REPO = path.resolve(LAB_DIR, '..', '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (k) => argv.includes(`--${k}`);
const PROFILE = opt('profile', 'full');
const DOMAIN = 'c20k.lab.test';
const lab = loadLab();

const { Client } = require('pg');
const bcrypt = require('bcrypt');
const env = Object.fromEntries(fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const pg = new Client({ connectionString: env.DATABASE_URL, application_name: 'lt-seed' });
await pg.connect();
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const q = async (sql, params) => (await pg.query(sql, params)).rows;
const uuid = () => crypto.randomUUID();

// ------------------------------------------------------------------ profile
const PROFILES = {
  full: {
    classes: [
      { name: 'hot', count: 1, branches: [{ n: 'Solo', d: 1 }, { n: 'Wide', d: 10 }, { n: 'Main', d: 3 }], customers: 20000, appts: 100000, audit: 20000, queuePool: 3000 },
      { name: 'large', count: 4, branches: Array.from({ length: 10 }, (_, i) => ({ n: `Branch ${i + 1}`, d: 4 })), customers: 5000, appts: 30000, audit: 5000, queuePool: 1200 },
      { name: 'small', count: 25, branches: [{ n: 'Main', d: 1 }], customers: 50, appts: 100, audit: 200, queuePool: 0 },
      { name: 'normal', count: 470, branches: null, customers: 400, appts: 1800, audit: 1000, queuePool: 400 },
    ],
    queueTenants: 100, notifPerUser: 30,
  },
  mini: {
    classes: [
      { name: 'hot', count: 1, branches: [{ n: 'Solo', d: 1 }, { n: 'Wide', d: 4 }, { n: 'Main', d: 2 }], customers: 2000, appts: 6000, audit: 1000, queuePool: 300 },
      { name: 'large', count: 1, branches: Array.from({ length: 4 }, (_, i) => ({ n: `Branch ${i + 1}`, d: 2 })), customers: 500, appts: 3000, audit: 500, queuePool: 200 },
      { name: 'small', count: 2, branches: [{ n: 'Main', d: 1 }], customers: 30, appts: 60, audit: 100, queuePool: 0 },
      { name: 'normal', count: 8, branches: null, customers: 100, appts: 300, audit: 200, queuePool: 60 },
    ],
    queueTenants: 6, notifPerUser: 10,
  },
}[PROFILE];
if (!PROFILES_OK(PROFILE)) { console.error('--profile must be full or mini'); process.exit(2); }
function PROFILES_OK(p) { return p === 'full' || p === 'mini'; }

// ------------------------------------------------------------------ safety + idempotency
const db = (await q('select current_database() d'))[0].d;
if (db !== lab.db.name) { console.error(`refusing: connected to "${db}", the lab database is "${lab.db.name}"`); process.exit(3); }
await q(`create table if not exists lt_lab_sentinel (key text primary key, value text not null)`);
await q(`create table if not exists lt_lab_tenant_class (tenant_id uuid primary key, idx int not null, class text not null)`);
const already = (await q(`select value from lt_lab_sentinel where key = 'seeded'`))[0];
if (already && !has('force') && !has('contract-only')) { console.log(`already seeded (${already.value}). Destroy the lab volumes to reseed: start-lab.mjs destroy`); process.exit(0); }
if (already && has('force')) { console.error('--force is not supported on a seeded DB (rows would collide on unique emails/slugs). Destroy the volumes and reseed.'); process.exit(3); }

// ------------------------------------------------------------------ schema contract
// Every NOT NULL column without a default must be one this script supplies. Fails BEFORE any write.
const SUPPLIED = {
  tenants: ['name', 'slug', 'contact_email'], tenant_settings: [], cities: [], branches: ['name'],
  users: [], user_roles: [], branch_users: [], staff_profiles: ['public_slug'], staff_services: [], staff_schedules: ['day_of_week', 'start_time', 'end_time'],
  working_hours: ['day_of_week', 'start_time', 'end_time'], services: ['tenantId', 'public_slug', 'name', 'duration_minutes'], service_prices: ['price'],
  customers: ['phone', 'email'], appointments: ['start_at', 'end_at'], audit_logs: ['action', 'entity_type'],
  tenant_specialties: ['tenantId', 'specialtyId', 'provenance'], staff_specialties: ['staffId', 'specialtyId', 'tenantId', 'provenance'],
  in_app_notifications: ['recipient_user_id', 'key', 'category'], whatsapp_accounts: [], merchant_accounts: [],
};
{
  const problems = [];
  for (const [table, supplied] of Object.entries(SUPPLIED)) {
    const rows = await q(`select column_name, is_identity, generation_expression from information_schema.columns
        where table_schema = 'public' and table_name = $1 and is_nullable = 'NO' and column_default is null`, [table]);
    if (!rows.length && !(await q(`select 1 from information_schema.tables where table_schema='public' and table_name=$1`, [table])).length) { problems.push(`${table}: table does not exist`); continue; }
    const needed = rows.filter((r) => r.is_identity !== 'YES' && !r.generation_expression).map((r) => r.column_name);
    const missing = needed.filter((c) => !supplied.includes(c) && !['id'].includes(c));
    if (missing.length) problems.push(`${table}: NOT NULL without default and not supplied by this seeder: ${missing.join(', ')}`);
  }
  if (problems.length) { console.error(`schema contract FAILED — the seeder is out of date with the migrations:\n  - ${problems.join('\n  - ')}`); process.exit(4); }
  log('schema contract OK (every required column is supplied)');
  if (has('contract-only')) process.exit(0);
}

// ------------------------------------------------------------------ prerequisites
const ROLE_NAMES = ['Clinic Owner', 'Operations Manager', 'Receptionist', 'Doctor', 'Nurse', 'Super Admin'];
const roleId = Object.fromEntries((await q(`select id, name from roles where "tenantId" is null and is_system and name = any($1)`, [ROLE_NAMES])).map((r) => [r.name, r.id]));
const missingRoles = ROLE_NAMES.filter((n) => !roleId[n]);
if (missingRoles.length) { console.error(`system roles missing (${missingRoles.join(', ')}) — run: node tests/load/lab/start-lab.mjs seed-rbac`); process.exit(4); }
const specialties = (await q(`select id, slug from specialties order by sort_order, slug`));
if (!specialties.length) { console.error('specialties taxonomy not seeded (migration 1730094) — migrate the lab first'); process.exit(4); }
log('hashing the lab login password once (bcrypt-12)…');
const PASSWORD_HASH = await bcrypt.hash(lab.secrets.loginPassword, 12);

// ------------------------------------------------------------------ helpers
async function bulk(table, cols, rows, chunk) {
  if (!rows.length) return;
  const per = chunk || Math.max(1, Math.floor(60000 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const params = []; const tuples = [];
    for (const r of part) { tuples.push(`(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`); }
    await pg.query(`insert into ${table} (${cols.map((c) => `"${c}"`).join(',')}) values ${tuples.join(',')}`, params);
  }
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ------------------------------------------------------------------ plan the tenants
const plan = [];
let idx = 0;
for (const cls of PROFILE_CLASSES()) for (let i = 0; i < cls.count; i++) {
  const branches = cls.branches || (idx % 2 === 0 ? [{ n: 'Main', d: 2 }, { n: 'North', d: 2 }] : [{ n: 'Main', d: 2 }, { n: 'North', d: 2 }, { n: 'South', d: 3 }]);
  plan.push({ idx, cls, branches, id: uuid() });
  idx++;
}
function PROFILE_CLASSES() { return PROFILES.classes; }
const TENANTS = plan.length;
log(`profile ${PROFILE}: ${TENANTS} tenants (${PROFILES.classes.map((c) => `${c.count} ${c.name}`).join(', ')})`);

await pg.query('begin');
try {
  // ---------------------------------------------------------------- tenants + settings
  await bulk('tenants', ['id', 'name', 'slug', 'contact_email', 'default_currency', 'default_timezone', 'approval_status', 'is_active'],
    plan.map((p) => [p.id, `C20K Clinic ${p.idx}`, `c20k-${p.idx}`, `owner.t${p.idx}@${DOMAIN}`, 'SAR', 'Asia/Riyadh', 'APPROVED', true]));
  await bulk('tenant_settings', ['tenant_id', 'currency', 'default_language', 'public_booking_enabled', 'bot_enabled'],
    plan.map((p) => [p.id, 'SAR', 'en', p.cls.name === 'hot' || p.cls.name === 'large' || p.idx % 5 < 2, false]));
  await bulk('lt_lab_tenant_class', ['tenant_id', 'idx', 'class'], plan.map((p) => [p.id, p.idx, p.cls.name]));
  log('tenants + settings');

  // ---------------------------------------------------------------- cities, branches
  if (!(await q('select 1 from cities limit 1')).length) {
    await bulk('cities', ['name_ar', 'name_en'], [['الرياض', 'Riyadh'], ['جدة', 'Jeddah'], ['الدمام', 'Dammam'], ['مكة', 'Makkah'], ['المدينة', 'Madinah']]);
  }
  const cityIds = (await q('select id from cities order by name_en')).map((r) => r.id);
  const branchRows = [];
  for (const p of plan) {
    p.branchSpecs = p.branches.map((b, i) => ({ ...b, id: uuid(), city: cityIds[(p.idx + i) % cityIds.length] }));
    for (const b of p.branchSpecs) branchRows.push([b.id, p.id, `${b.n}`, `${b.n} St, ${p.idx}`, b.city]);
  }
  await bulk('branches', ['id', 'tenantId', 'name', 'address', 'city_id'], branchRows);
  log(`branches: ${branchRows.length}`);

  // ---------------------------------------------------------------- users, roles, staff
  const userRows = []; const urRows = []; const buRows = []; const staffRows = [];
  const addUser = (p, email, name, role) => {
    const id = uuid();
    userRows.push([id, p ? p.id : null, email, name, PASSWORD_HASH, true]);
    urRows.push([id, roleId[role]]);
    return id;
  };
  for (const p of plan) {
    const t = p.idx;
    addUser(p, `perf.owner.t${t}.1@${DOMAIN}`, `Owner t${t}`, 'Clinic Owner');
    addUser(p, `perf.manager.t${t}.1@${DOMAIN}`, `Manager t${t}`, 'Operations Manager');
    for (let n = 1; n <= 2; n++) addUser(p, `perf.receptionist.t${t}.${n}@${DOMAIN}`, `Receptionist t${t} ${n}`, 'Receptionist');
    const nurseUser = addUser(p, `perf.nurse.t${t}.1@${DOMAIN}`, `Nurse t${t}`, 'Nurse');
    buRows.push([p.id, p.branchSpecs[0].id, nurseUser, true]);
    p.staff = [];
    p.branchSpecs.forEach((b, bi) => {
      for (let n = 1; n <= b.d; n++) {
        const uid = addUser(p, `perf.doctor.t${t}.b${bi}.${n}@${DOMAIN}`, `Dr. t${t} b${bi} ${n}`, 'Doctor');
        const sid = uuid();
        staffRows.push([sid, uid, p.id, `dr-${t}-${bi}-${n}`, 'Consultant', 0, true]);
        buRows.push([p.id, b.id, uid, n === 1]);
        p.staff.push({ s: sid, b: b.id, u: uid });
      }
    });
  }
  // platform super admin + dedicated auth-probe accounts (never share an account with the load population)
  addUser(null, `lab.superadmin@${DOMAIN}`, 'Lab Super Admin', 'Super Admin');
  const authBad = Number(opt('auth-bad', PROFILE === 'full' ? 300 : 20));
  const authLock = Number(opt('auth-lock', PROFILE === 'full' ? 100 : 10));
  for (let n = 1; n <= authBad; n++) addUser(plan[(n * 7) % TENANTS], `auth.bad.${n}@${DOMAIN}`, `Auth Bad ${n}`, 'Receptionist');
  for (let n = 1; n <= authLock; n++) addUser(plan[(n * 11) % TENANTS], `auth.lock.${n}@${DOMAIN}`, `Auth Lock ${n}`, 'Receptionist');
  await bulk('users', ['id', 'tenantId', 'email', 'full_name', 'password_hash', 'is_active'], userRows);
  await bulk('user_roles', ['userId', 'roleId'], urRows);
  await bulk('branch_users', ['tenantId', 'branchId', 'userId', 'is_primary'], buRows);
  await bulk('staff_profiles', ['id', 'user_id', 'tenantId', 'public_slug', 'title', 'booking_buffer_minutes', 'is_available_for_booking'], staffRows);
  log(`users ${userRows.length}, staff ${staffRows.length}`);

  // ---------------------------------------------------------------- services, prices, schedules, specialties
  const SERVICES = [['General Consultation', 30, 150], ['Follow-up Visit', 15, 80], ['Dental Cleaning', 45, 250], ['Dental Filling', 60, 400],
    ['Skin Assessment', 30, 200], ['Laser Session', 45, 600], ['Physiotherapy', 60, 300], ['Lab Panel', 15, 120]];
  const svcRows = [];
  for (const p of plan) {
    const sp1 = specialties[p.idx % specialties.length].id; const sp2 = specialties[(p.idx + 5) % specialties.length].id;
    p.specialties = [sp1, sp2];
    p.services = SERVICES.map(([name, dur, price], i) => ({ id: uuid(), name, dur, price, spec: i % 2 ? sp2 : sp1, slug: slugify(name) }));
    for (const s of p.services) svcRows.push([s.id, p.id, s.slug, s.name, 'Load-test service', s.dur, 'FIXED', s.price, true, s.spec]);
  }
  await bulk('services', ['id', 'tenantId', 'public_slug', 'name', 'description', 'duration_minutes', 'pricing_type', 'base_price', 'is_active', 'specialtyId'], svcRows);
  const spRows = []; const ssRows = []; const stsRows = []; const tsRows = [];
  for (const p of plan) {
    for (const sp of p.specialties) tsRows.push([p.id, sp, 'ASSERTED']);
    for (const b of p.branchSpecs) for (const s of p.services) spRows.push([s.price, s.id, b.id, p.id]);
    for (const st of p.staff) { stsRows.push([st.s, p.specialties[0], p.id, 'ASSERTED']); for (const s of p.services) ssRows.push([st.s, s.id, p.id]); }
  }
  await bulk('tenant_specialties', ['tenantId', 'specialtyId', 'provenance'], tsRows);
  await bulk('staff_specialties', ['staffId', 'specialtyId', 'tenantId', 'provenance'], stsRows);
  await bulk('service_prices', ['price', 'serviceId', 'branchId', 'tenantId'], spRows);
  await bulk('staff_services', ['staffId', 'serviceId', 'tenantId'], ssRows);
  // 08:00-20:00 every day, at the doctor's own branch and for each branch (set-based)
  await pg.query(`insert into staff_schedules (day_of_week, start_time, end_time, is_active, "staffId", "branchId", "tenantId")
      select d, time '08:00', time '20:00', true, sp.id, bu."branchId", sp."tenantId"
        from staff_profiles sp join branch_users bu on bu."userId" = sp.user_id cross join generate_series(0, 6) d`);
  await pg.query(`insert into working_hours (day_of_week, start_time, end_time, is_closed, "branchId", "tenantId")
      select d, time '08:00', time '20:00', false, b.id, b."tenantId" from branches b cross join generate_series(0, 6) d`);
  log('services, prices, schedules, specialties');

  // ---------------------------------------------------------------- customers (deterministic names; see flows/crm-search.js)
  const FIRST = "ARRAY['Ahmed','Mohammed','Sara','Ali','Fatima','Omar','Layla','Khalid','Noor','Yusuf']";
  const LAST = "ARRAY['Alharbi','Alqahtani','Alotaibi','Alshehri','Alghamdi','Aldosari','Almutairi','Alzahrani']";
  for (const p of plan) {
    await pg.query(`insert into customers ("tenantId", full_name, phone, email, is_active, source)
        select $1, (${FIRST})[1 + n % 10] || ' ' || (${LAST})[1 + n % 8] || ' C' || $2::text || '-' || n,
               '+9665' || lpad($2::text, 3, '0') || lpad(n::text, 5, '0'), 'cust.' || $2::text || '.' || n || '@lab.test', true, 'lab'
          from generate_series(0, $3::int - 1) n`, [p.id, p.idx, p.cls.customers]);
  }
  log(`customers: ${plan.reduce((a, p) => a + p.cls.customers, 0)}`);

  // ---------------------------------------------------------------- appointments (sequential, never overlapping per staff)
  const STATUS_PAST = "ARRAY['COMPLETED','COMPLETED','COMPLETED','COMPLETED','COMPLETED','COMPLETED','COMPLETED','CANCELLED','NO_SHOW','COMPLETED']";
  const PAY_PAST = "ARRAY['PAID','PAID','PAID','PAID','PAID','PAID','PAID','UNPAID','UNPAID','PAID']";
  const SOURCE = "ARRAY['PLATFORM','MANUAL','WHATSAPP_BOT','PUBLIC_AI','MANUAL']";
  for (const p of plan) {
    const ns = p.staff.length;
    const days = Math.ceil(p.cls.appts / ns / 8);
    await pg.query(`
      with st as (select $2::jsonb j, $3::int ns), cu as (select array_agg(id order by id) as ids, count(*)::int n from customers where "tenantId" = $1),
      g as (
        select gs.a, (gs.a / st.ns) as seq, st.j, st.ns, cu.ids as ca, cu.n as cn
          from generate_series(0, $4::int - 1) as gs(a), st, cu
      ), t as (
        select g.*, (date_trunc('day', now()) - (($5::int * 85) / 100) * interval '1 day'
                     + (g.seq / 8) * interval '1 day' + interval '5 hours' + (g.seq % 8) * interval '45 minutes') as start_at
          from g
      )
      insert into appointments ("tenantId","branchId","customerId","staffId",start_at,end_at,status,payment_status,total_amount,currency,source)
      select $1, (j -> (a % ns) ->> 'b')::uuid, ca[1 + (a * 7 + a / 13) % cn], (j -> (a % ns) ->> 's')::uuid,
             start_at, start_at + interval '45 minutes',
             (case when start_at < now() then (${STATUS_PAST})[1 + a % 10] else (case when a % 5 = 0 then 'PENDING_PAYMENT' else 'CONFIRMED' end) end)::appointments_status_enum,
             (case when start_at < now() then (${PAY_PAST})[1 + a % 10] else 'UNPAID' end)::appointments_payment_status_enum,
             150 + (a % 20) * 10, 'SAR', (${SOURCE})[1 + a % 5]::appointments_source_enum
        from t`, [p.id, JSON.stringify(p.staff.map((s) => ({ s: s.s, b: s.b }))), ns, p.cls.appts, days]);
  }
  log(`appointments: ${plan.reduce((a, p) => a + p.cls.appts, 0)}`);

  // ---------------------------------------------------------------- queue check-in pool (CONFIRMED, band 12:00-16:45 UTC, no overlap with the 05:00-11:00 band)
  const queueTenants = plan.filter((p) => p.cls.queuePool > 0).slice(0, PROFILES.queueTenants);
  for (const p of queueTenants) {
    // the branch with most doctors; its doctors' slots
    const widest = [...p.branchSpecs].sort((a, b) => b.d - a.d)[0];
    const staff = p.staff.filter((s) => s.b === widest.id);
    await pg.query(`
      with st as (select $2::jsonb j, $3::int ns), cu as (select array_agg(id order by id) as ids, count(*)::int n from customers where "tenantId" = $1),
      g as (select gs.a, (gs.a / st.ns) seq, st.j, st.ns, cu.ids as ca, cu.n as cn from generate_series(0, $4::int - 1) as gs(a), st, cu)
      insert into appointments ("tenantId","branchId","customerId","staffId",start_at,end_at,status,payment_status,total_amount,currency,source,notes)
      select $1, $5::uuid, ca[1 + (a * 3) % cn], (j -> (a % ns) ->> 's')::uuid,
             date_trunc('day', now()) + interval '10 days' + (seq / 6) * interval '1 day' + interval '12 hours' + (seq % 6) * interval '45 minutes',
             date_trunc('day', now()) + interval '10 days' + (seq / 6) * interval '1 day' + interval '12 hours' + (seq % 6) * interval '45 minutes' + interval '45 minutes',
             'CONFIRMED', 'UNPAID', null, 'SAR', 'MANUAL', 'lt-queue-pool'
        from g`, [p.id, JSON.stringify(staff.map((s) => ({ s: s.s, b: s.b }))), staff.length, p.cls.queuePool, widest.id]);
  }
  log(`queue pools: ${queueTenants.length} tenants`);

  // ---------------------------------------------------------------- audit logs + inbox notifications
  const ACTIONS = "ARRAY['appointment.created','appointment.updated','appointment.cancelled','customer.created','customer.updated','staff.updated','invoice.created','payment.recorded']";
  const TYPES = "ARRAY['Appointment','Appointment','Appointment','Customer','Customer','StaffProfile','Invoice','Payment']";
  for (const p of plan) {
    await pg.query(`insert into audit_logs (action, entity_type, entity_id, "tenantId", "userId", "branchId", entity_label, created_at)
        select (${ACTIONS})[1 + n % 8], (${TYPES})[1 + n % 8], uuid_generate_v4(), $1, $2, $3, (${TYPES})[1 + n % 8] || ' #' || n, now() - random() * interval '180 days'
          from generate_series(1, $4::int) n`, [p.id, p.staff[0].u, p.branchSpecs[0].id, p.cls.audit]);
  }
  await pg.query(`insert into in_app_notifications ("tenantId", recipient_user_id, key, category, priority, variables, read_at, created_at)
      select u."tenantId", u.id, 'SUPPORT_TICKET_STATUS_CHANGED', 'SUPPORT', 'NORMAL',
             jsonb_build_object('ticketNumber', 'T-' || n, 'subject', 'Load test ticket', 'fromStatus', 'OPEN', 'toStatus', 'RESOLVED'),
             case when n % 5 < 2 then now() else null end, now() - n * interval '1 hour'
        from users u cross join generate_series(1, $1::int) n where u."tenantId" is not null and u.email like 'perf.%'`, [PROFILES.notifPerUser]);
  log('audit logs + inbox notifications');

  // ---------------------------------------------------------------- external-effect surface (inert by construction)
  // WhatsApp: tokenless accounts for 1 tenant in 10 (webhook routing only; no access_token => no send possible)
  const waTenants = plan.filter((p) => p.idx % 10 === 1);
  await bulk('whatsapp_accounts', ['tenantId', 'phone_number_id', 'is_default', 'is_active'], waTenants.map((p) => [p.id, `lt-pn-${p.idx}`, true, true]));
  // Tap merchants for the payment tenants (1 in 10): approved + a valid recipient id => online payment is available
  const payTenants = plan.filter((p) => p.idx % 10 === 0);
  await bulk('merchant_accounts', ['tenantId', 'status', 'provider', 'provider_recipient_id', 'approved_at'],
    payTenants.map((p) => [p.id, 'APPROVED', 'tap', `merchant_lab_${p.idx}`, new Date()]));
  log(`whatsapp accounts ${waTenants.length} (tokenless), tap merchants ${payTenants.length}`);

  await bulk('lt_lab_sentinel', ['key', 'value'], [['lab', 'ziyarati-c20k'], ['profile', PROFILE], ['seeded', new Date().toISOString()],
    ['loginEmailDomain', DOMAIN]]);
  await pg.query('commit');
} catch (e) {
  await pg.query('rollback').catch(() => {});
  console.error(`\nSEED FAILED (rolled back): ${e.message}`);
  if (e.detail) console.error(`  detail: ${e.detail}`);
  process.exit(1);
}

await pg.query('analyze');
const c = (await q(`select (select count(*) from tenants)::int tenants, (select count(*) from users)::int users, (select count(*) from staff_profiles)::int staff,
   (select count(*) from customers)::int customers, (select count(*) from appointments)::int appointments, (select count(*) from audit_logs)::int audit,
   pg_size_pretty(pg_database_size(current_database())) size`))[0];
log(`DONE ${JSON.stringify(c)}`);
console.log(`next: node tests/load/lab/mint-sessions.mjs   (login email domain ${DOMAIN}; password in lab/run/lab.json — never printed)`);
await pg.end();
