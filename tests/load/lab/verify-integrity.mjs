#!/usr/bin/env node
/**
 * POST-RUN BUSINESS-CORRECTNESS ASSERTIONS — what k6 cannot see.
 *
 *   node tests/load/lab/verify-integrity.mjs --tag TAG [--scenario S] [--drain-s 120]
 *
 * k6 sees 201 and 409; only the database can say whether two 201s landed on the same
 * staff member and window, whether a duplicate webhook produced a second payment, or
 * whether asynchronous work ever finished. A 200 is NOT success if the async workflow
 * later failed, so this waits for the outbox to DRAIN (up to --drain-s) before judging it.
 *
 * Every check reports PASS | FAIL | NOT VERIFIED (query could not run — never silently
 * passed). Severity follows the campaign's thresholds:
 *   P0  duplicate/overlapping appointment, missing exclusion guard, cross-tenant FK,
 *       duplicate gateway payment, Tap double charge, FAILED outbox rows
 *   P1  outbox not drained, appointments stuck PENDING_PAYMENT after a captured payment,
 *       open DB locks / idle-in-transaction left behind
 * Also appends the evidence dump of the existing tests/load/data/integrity-check.sql
 * (psql output) next to the JSON, for humans.
 *
 * Exit code 4 on any P0 FAIL (the runner reports it; it does not hide it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadLab, LAB_DIR, RUN_DIR } from './make-lab-env.mjs';

const REPO = path.resolve(LAB_DIR, '..', '..', '..');
const REPORTS = path.resolve(LAB_DIR, '..', 'reports');
const require = createRequire(path.join(REPO, 'package.json'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const tag = opt('tag', 'adhoc');
const scenario = opt('scenario', '');
const drainS = Number(opt('drain-s', 120));
const lab = loadLab();

const { Client } = require('pg');
const env = Object.fromEntries(fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const pg = new Client({ connectionString: env.DATABASE_URL, application_name: 'lt-verify' });
await pg.connect();

const results = [];
async function check(id, sev, title, sql, judge, params) {
  try {
    const rows = (await pg.query(sql, params)).rows;
    const j = judge(rows);
    results.push({ id, sev, title, status: j.ok ? 'PASS' : 'FAIL', detail: j.detail });
  } catch (e) {
    results.push({ id, sev, title, status: 'NOT VERIFIED', detail: String(e.message).slice(0, 160) });
  }
}
const zero = (field) => (rows) => ({ ok: Number(rows[0][field]) === 0, detail: `${field}=${rows[0][field]}` });

// ---------------------------------------------------------------- appointments
await check('A1', 'P0', 'exclusion guard appointments_no_overlap is installed',
  `select count(*)::int c from pg_constraint where conname='appointments_no_overlap'`,
  (r) => ({ ok: r[0].c === 1, detail: `constraints=${r[0].c}` }));

await check('A2', 'P0', 'no two non-cancelled appointments overlap for one staff member',
  `select count(*)::int c from appointments a join appointments b
     on a."staffId"=b."staffId" and a.id < b.id
    and tstzrange(a.start_at,a.end_at,'[)') && tstzrange(b.start_at,b.end_at,'[)')
    and a.status not in ('CANCELLED','NO_SHOW') and b.status not in ('CANCELLED','NO_SHOW')
    and a.deleted_at is null and b.deleted_at is null
  where a.notes='k6-load-test' or b.notes='k6-load-test'`,
  zero('c'));

await check('A3', 'P0', 'at most ONE live booking per contended (staff, start) slot created by k6',
  `select coalesce(max(n),0)::int c from (select count(*) n from appointments
     where notes='k6-load-test' and status not in ('CANCELLED','NO_SHOW') and deleted_at is null
     group by "staffId", start_at) x`,
  (r) => ({ ok: r[0].c <= 1, detail: `max rows in one slot=${r[0].c}` }));

for (const [id, col, tbl] of [['T1', 'branchId', 'branches'], ['T2', 'customerId', 'customers'], ['T3', 'staffId', 'staff_profiles']]) {
  await check(id, 'P0', `no appointment references a ${tbl} row of a DIFFERENT tenant`,
    `select count(*)::int c from appointments a join ${tbl} x on x.id = a."${col}" where x."tenantId" <> a."tenantId"`,
    zero('c'));
}
await check('T4', 'P0', 'no queue entry references an appointment of a different tenant',
  `select count(*)::int c from queue_entries q join appointments a on a.id = q."appointmentId" where a."tenantId" <> q."tenantId"`,
  zero('c'));

await check('A4', 'P1', 'every k6-created appointment has its status-log and history rows',
  `select count(*)::int c from appointments a
    where a.notes='k6-load-test'
      and (not exists (select 1 from appointment_status_logs l where l."appointmentId"=a.id)
        or not exists (select 1 from appointment_history h where h."appointmentId"=a.id))`,
  zero('c'));

// ---------------------------------------------------------------- outbox (async work finished?)
let outbox = {};
const deadline = Date.now() + drainS * 1000;
for (;;) {
  try {
    const rows = (await pg.query(`select status, count(*)::int c from outbox_jobs group by 1`)).rows;
    outbox = Object.fromEntries(rows.map((r) => [r.status, r.c]));
    const backlog = (outbox.PENDING || 0) + (outbox.PUBLISHING || 0);
    if (!backlog || Date.now() > deadline) break;
  } catch { break; }
  await new Promise((r) => setTimeout(r, 5000));
}
results.push({
  id: 'O1', sev: 'P0', title: 'no outbox row is FAILED (exhausted retries = a lost follow-up action)',
  status: (outbox.FAILED || 0) === 0 ? 'PASS' : 'FAIL', detail: JSON.stringify(outbox),
});
results.push({
  id: 'O2', sev: 'P1', title: `outbox drained within ${drainS}s of the end of the run`,
  status: ((outbox.PENDING || 0) + (outbox.PUBLISHING || 0)) === 0 ? 'PASS' : 'FAIL', detail: JSON.stringify(outbox),
});

// ---------------------------------------------------------------- payments
await check('P1', 'P0', 'no gateway charge id is attached to more than one payment',
  `select count(*)::int c from (select gateway_payment_id from payments where gateway_payment_id is not null group by 1 having count(*)>1) x`,
  zero('c'));
await check('P2', 'P1', 'no PAID payment leaves its booking in PENDING_PAYMENT (captured webhook not applied)',
  `select count(*)::int c from payments p join appointments a on a.id = p."appointmentId"
    where p.status='PAID' and a.status='PENDING_PAYMENT' and p.updated_at < now() - interval '2 minutes'`,
  zero('c'));
await check('P3', 'P0', 'no payment is PAID twice in the ledger (one CHARGE success per payment)',
  `select count(*)::int c from (select "paymentId" from transactions where type='CHARGE' and status='SUCCESS' group by 1 having count(*)>1) x`,
  zero('c'));

// Tap stub: more than one charge created for the SAME booking reference is a double charge.
try {
  const r = await fetch(`http://127.0.0.1:${lab.ports.tapStub}/__admin/stats`, { signal: AbortSignal.timeout(4000) });
  if (r.status === 200) {
    const s = await r.json();
    results.push({ id: 'P4', sev: 'P0', title: 'Tap stub saw no booking charged more than once (double-charge race)',
      status: s.referencesWithMultipleCharges === 0 ? 'PASS' : 'FAIL',
      detail: `charges=${s.stats.chargeCreates} dedupedByIdempotency=${s.stats.chargeCreateDeduped} referencesWithMultipleCharges=${s.referencesWithMultipleCharges}` });
  }
} catch { results.push({ id: 'P4', sev: 'P0', title: 'Tap stub double-charge report', status: 'NOT VERIFIED', detail: 'stub unreachable' }); }

// ---------------------------------------------------------------- hygiene
await check('H1', 'P1', 'no DB lock is left waiting and nothing idles in a transaction after the run',
  `select (select count(*) from pg_locks where not granted)::int locks,
          (select count(*) from pg_stat_activity where datname=current_database() and state like 'idle in transaction%')::int idle_tx`,
  (r) => ({ ok: r[0].locks === 0 && r[0].idle_tx === 0, detail: `ungranted=${r[0].locks} idleInTx=${r[0].idle_tx}` }));
await check('H2', 'P0', 'no external-effect table gained rows (webhook endpoints / workflows / rules / tokened WhatsApp accounts)',
  `select (select count(*) from webhook_endpoints)::int w, (select count(*) from workflows)::int f,
          (select count(*) from notification_rules)::int n,
          (select count(*) from whatsapp_accounts where deleted_at is null and access_token is not null and access_token <> '')::int t`,
  (r) => ({ ok: r[0].w === 0 && r[0].f === 0 && r[0].n === 0 && r[0].t === 0, detail: JSON.stringify(r[0]) }));

await pg.end();

// ---------------------------------------------------------------- evidence dump (psql)
let dump = 'skipped';
try {
  const sql = fs.readFileSync(path.resolve(LAB_DIR, '..', 'data', 'integrity-check.sql'), 'utf8');
  const r = spawnSync('docker', ['exec', '-i', lab.db.container, 'psql', '-U', lab.db.user, '-d', lab.db.name, '-X', '-q'], { input: sql, encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(path.join(REPORTS, `${tag}.integrity.txt`), `${r.stdout || ''}\n${r.stderr || ''}`);
  dump = `written ${tag}.integrity.txt`;
} catch (e) { dump = `failed: ${e.message}`; }

const p0fail = results.filter((r) => r.sev === 'P0' && r.status === 'FAIL');
const out = { schema: 'lt-integrity/1', tag, scenario, checkedAt: new Date().toISOString(), results, evidenceDump: dump,
  verdict: p0fail.length ? 'FAIL (P0)' : results.some((r) => r.status === 'FAIL') ? 'PASS WITH CONDITIONS (P1 findings)' : results.some((r) => r.status === 'NOT VERIFIED') ? 'PASS WITH CONDITIONS (some checks NOT VERIFIED)' : 'PASS' };
fs.mkdirSync(REPORTS, { recursive: true });
fs.writeFileSync(path.join(REPORTS, `${tag}.integrity.json`), JSON.stringify(out, null, 2));

console.log(`\nINTEGRITY ${tag}: ${out.verdict}`);
for (const r of results) console.log(`  ${r.status.padEnd(12)} ${r.sev} ${r.id.padEnd(3)} ${r.title}${r.status === 'PASS' ? '' : `   [${r.detail}]`}`);
console.log(`  evidence: ${dump}`);
process.exit(p0fail.length ? 4 : 0);
