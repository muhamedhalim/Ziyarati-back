#!/usr/bin/env node
/**
 * Builds the API-driven data packs. REQUIRES the lab API (+ Tap stub for payments) to be running and
 * mint-sessions.mjs to have produced sessions.json.
 *
 *   node tests/load/lab/build-packs.mjs [--partner N] [--links N] [--webhooks N] [--returns N]
 *                                       [--refundables N] [--marketplace-key] [--only partner|payments]
 *
 * Everything goes through the app's REAL endpoints with the owners' offline-signed Bearer tokens
 * (accepted outside production), so the packs also prove those creation paths work:
 *
 *   pack-partner.json   per tenant: API key (all tenant-grantable integration scopes), an ACTIVE
 *                       generic_rest connection, an inbound webhook endpoint (secret). One row per
 *                       tenant for N tenants. SECRETS: gitignored, never printed.
 *   pack-pay-links.json       [{token}]  payable pay links (POST /payment-links on future unpaid bookings
 *                                        of the Tap-approved tenants)
 *   pack-pay-webhooks.json    [{chargeId,paymentId,amount,currency}]  PENDING payments created by the REAL
 *                                        public checkout against the stub (chargeId parsed from redirectUrl)
 *   pack-pay-returns.json     [{chargeId}]  same, for POST /public/payments/return
 *   pack-pay-refundables.json [{tenantId,paymentId}]  payments driven to PAID by a signed webhook
 *
 * NOT BUILT (stated, not hidden): subscription-invoice checkout and renewal packs (pack-pay-invoices) — they
 * need subscriptions/plans whose limits interact with access control; the billing flows skip when empty.
 *
 * Counts default to what the default scenario rates consume (rate x duration). Each pack row is consumed
 * ONCE, so enlarge the pack before enlarging a scenario's rate or duration; run-campaign does not check this.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadLab, LAB_DIR, RUN_DIR } from './make-lab-env.mjs';

const REPO = path.resolve(LAB_DIR, '..', '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (k) => argv.includes(`--${k}`);
const OUT = path.resolve(LAB_DIR, '..', 'data', 'generated');
const lab = loadLab();
const API = `http://127.0.0.1:${lab.ports.api}/api/v1`;
const STUB = `http://127.0.0.1:${lab.ports.tapStub}`;
const only = opt('only', 'all');
const N_PARTNER = Number(opt('partner', 100));
const N_LINKS = Number(opt('links', 3000));
const N_WEBHOOKS = Number(opt('webhooks', 3000));
const N_RETURNS = Number(opt('returns', 1500));
const N_REFUNDABLES = Number(opt('refundables', 200));

if (!fs.existsSync(path.join(OUT, 'sessions.json'))) { console.error('sessions.json missing — run mint-sessions.mjs first'); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(path.join(OUT, 'sessions.json'), 'utf8'));
const ownerOf = (tenantId) => doc.sessions[doc.index.ownerByTenant[tenantId]];
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, token, body, extra) {
  const r = await fetch(url, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}, extra || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return { status: r.status, json: j };
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); } }));
  return out;
}
const errCode = (r) => `${r.status}${r.json && r.json.code ? ` ${r.json.code}` : ''}`;

// ------------------------------------------------------------------ DB (read-mostly)
const { Client } = require('pg');
const env = Object.fromEntries(fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const pg = new Client({ connectionString: env.DATABASE_URL, application_name: 'lt-packs' });
await pg.connect();
const q = async (sql, params) => (await pg.query(sql, params)).rows;

// ================================================================== partner pack
if (only === 'all' || only === 'partner') {
  const SCOPES = [];
  for (const r of ['services', 'staff', 'availability', 'customers', 'appointments']) SCOPES.push(`integration.${r}.read`);
  for (const r of ['customers', 'services', 'staff', 'appointments']) SCOPES.push(`integration.${r}.write`);
  const EVENTS = ['customer.upserted', 'service.upserted', 'staff.upserted', 'appointment.created', 'appointment.rescheduled', 'appointment.cancelled'];
  // spread across classes: owners of the first N tenants that have branches + a customer
  const owners = Object.entries(doc.index.ownerByTenant).map(([t, i]) => doc.sessions[i]).filter((s) => s.pairs.length && s.customerIds.length).slice(0, N_PARTNER);
  const failures = {};
  const rows = (await pool(owners, 8, async (s) => {
    const note = (step, r) => { failures[`${step} ${errCode(r)}`] = (failures[`${step} ${errCode(r)}`] || 0) + 1; };
    const key = await call('POST', `${API}/platform/api-keys`, s.access, { name: `lt-partner-${s.tenantIndex}`, permissions: SCOPES });
    if (key.status >= 300 || !key.json || !key.json.apiKey) { note('api-key', key); return null; }
    const conn = await call('POST', `${API}/platform/integrations/connections`, s.access, { name: `lt-conn-${s.tenantIndex}`, provider: 'custom' });
    if (conn.status >= 300 || !conn.json || !conn.json.id) { note('connection', conn); return null; }
    const act = await call('POST', `${API}/platform/integrations/connections/${conn.json.id}/activate`, s.access);
    if (act.status >= 300) note('activate', act);
    const ep = await call('POST', `${API}/platform/integrations/webhooks/endpoints`, s.access, { connectionId: conn.json.id, allowedEvents: EVENTS });
    if (ep.status >= 300) note('endpoint', ep);
    const pr = s.pairs[0];
    return { tenantId: s.tenantId, apiKey: key.json.apiKey, connectionId: conn.json.id, branchId: pr.branchId, staffId: pr.staffIds[0],
      customerId: s.customerIds[0], endpointId: ep.json && ep.json.id, endpointSecret: ep.json && (ep.json.secret || ep.json.signingSecret) || null };
  })).filter(Boolean);
  write('pack-partner.json', rows);
  console.log(`partner pack: ${rows.length}/${owners.length} tenants (endpoint secrets: ${rows.filter((r) => r.endpointSecret).length})`);
  if (Object.keys(failures).length) console.log(`  step failures (status code only): ${JSON.stringify(failures)}`);
}

// ================================================================== marketplace key (optional)
if (has('marketplace-key')) {
  const ts = path.join(REPO, 'node_modules', 'ts-node', 'dist', 'bin.js');
  const r = spawnSync(process.execPath, [ts, '--project', path.join(REPO, 'tsconfig.seed.json'), path.join(REPO, 'scripts', 'mint-marketplace-api-key.ts')], {
    cwd: RUN_DIR, encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, Object.fromEntries(fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }))),
  });
  const m = /\b([A-Za-z]{2,10}_[A-Za-z0-9_-]{32,})\b/.exec(r.stdout || '');
  if (m) { fs.writeFileSync(path.join(RUN_DIR, 'marketplace-key.txt'), m[1], { mode: 0o600 }); console.log('marketplace key minted -> lab/run/marketplace-key.txt (use run-campaign --marketplace-key)'); }
  else console.log(`marketplace key NOT minted (script exit ${r.status}); per-visitor throttle path stays NOT TESTED`);
}

// ================================================================== payments packs
if (only === 'all' || only === 'payments') {
  const stubOk = await fetch(`${STUB}/__admin/stats`).then((r) => r.status === 200).catch(() => false);
  if (!stubOk) { console.error('Tap stub not reachable — start it (start-lab.mjs stub) before building payment packs'); process.exit(1); }
  const tenants = await q(`select m."tenantId" t, c.idx from merchant_accounts m join lt_lab_tenant_class c on c.tenant_id = m."tenantId" where m.status = 'APPROVED' and m.provider = 'tap' order by c.idx`);
  const need = N_LINKS + N_WEBHOOKS + N_RETURNS;
  const perTenant = Math.ceil(need / Math.max(1, tenants.length));
  const pickups = [];
  for (const t of tenants) {
    const rows = await q(`select id, total_amount::float8 amt from appointments where "tenantId" = $1 and payment_status = 'UNPAID' and total_amount > 0
        and status in ('PENDING_PAYMENT','CONFIRMED') and start_at > now() and notes is null and deleted_at is null order by start_at limit $2`, [t.t, perTenant]);
    for (const r of rows) pickups.push({ tenantId: t.t, appointmentId: r.id, amount: r.amt });
  }
  console.log(`payment tenants: ${tenants.length}; unpaid future bookings available: ${pickups.length} (need ${need})`);
  if (pickups.length < need) console.log(`  WARNING: fewer bookings than requested — pack sizes will be reduced proportionally`);
  const scale = Math.min(1, pickups.length / need);
  const nL = Math.floor(N_LINKS * scale); const nW = Math.floor(N_WEBHOOKS * scale); const nR = Math.floor(N_RETURNS * scale);
  // interleave tenants so every set spans every tenant
  pickups.sort((a, b) => (a.appointmentId < b.appointmentId ? -1 : 1));

  // 1. a pay link per booking
  const links = (await pool(pickups.slice(0, nL + nW + nR), 16, async (p) => {
    const s = ownerOf(p.tenantId); if (!s) return null;
    const r = await call('POST', `${API}/payment-links`, s.access, { amount: p.amount, appointmentId: p.appointmentId });
    if (r.status >= 300 || !r.json || !r.json.link_token) return { err: errCode(r) };
    return Object.assign({}, p, { token: r.json.link_token });
  }));
  const errs = {}; for (const l of links) if (l && l.err) errs[l.err] = (errs[l.err] || 0) + 1;
  const good = links.filter((l) => l && l.token);
  console.log(`pay links created: ${good.length}/${links.length}${Object.keys(errs).length ? `  failures ${JSON.stringify(errs)}` : ''}`);
  const linkSet = good.slice(0, nL);
  const webSet = good.slice(nL, nL + nW);
  const retSet = good.slice(nL + nW, nL + nW + nR);
  write('pack-pay-links.json', linkSet.map((l) => ({ token: l.token })));

  // 2. the REAL public checkout creates a PENDING payment + a stub charge; chargeId comes from redirectUrl
  async function checkout(l) {
    const r = await call('POST', `${API}/public/payments/links/${l.token}/checkout`, null, undefined);
    if (r.status !== 200 || !r.json || r.json.state !== 'redirect') return null;
    const m = /(chg_[A-Za-z0-9_-]+)/.exec(String(r.json.redirectUrl || ''));
    return m ? m[1] : null;
  }
  const withCharge = async (set) => (await pool(set, 16, async (l) => { const chargeId = await checkout(l); return chargeId ? Object.assign({}, l, { chargeId }) : null; })).filter(Boolean);
  const webCharged = await withCharge(webSet);
  const retCharged = await withCharge(retSet);
  const pay = async (set) => {
    const out = [];
    for (const l of set) {
      const rows = await q(`select id, amount::float8 amt, currency from payments where gateway_payment_id = $1`, [l.chargeId]);
      if (rows[0]) out.push({ tenantId: l.tenantId, chargeId: l.chargeId, paymentId: rows[0].id, amount: rows[0].amt, currency: rows[0].currency });
    }
    return out;
  };
  let web = await pay(webCharged); const ret = await pay(retCharged);
  console.log(`checkouts via stub: webhook rows ${web.length}/${webSet.length}, return rows ${ret.length}/${retSet.length}`);

  // 3. the stub must report these CAPTURED when the app re-fetches them
  await fetch(`${STUB}/__admin/preload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: [...web, ...ret] }) });

  // 4. refundables: drive the first R webhook rows to PAID with a correctly signed webhook
  const hash = (b) => {
    const dec = ['BHD', 'KWD', 'OMR', 'JOD'].includes(String(b.currency).toUpperCase()) ? 3 : 2;
    const c = `x_id${b.id}x_amount${Number(b.amount).toFixed(dec)}x_currency${b.currency}x_gateway_reference${b.reference.gateway}x_payment_reference${b.reference.payment}x_status${b.status}x_created${b.transaction.created}`;
    return crypto.createHmac('sha256', lab.secrets.tapSecret).update(c).digest('hex');
  };
  const refundables = [];
  for (const w of web.slice(0, N_REFUNDABLES)) {
    const body = { id: w.chargeId, object: 'charge', status: 'CAPTURED', amount: w.amount, currency: w.currency,
      reference: { gateway: `gw_${w.chargeId}`, payment: `pay_${w.chargeId}`, transaction: w.paymentId }, transaction: { created: String(Date.now()) }, metadata: { udf1: w.paymentId } };
    const r = await call('POST', `${API}/payments/webhooks/tap`, null, body, { hashstring: hash(body) });
    if (r.status === 200) refundables.push({ tenantId: w.tenantId, paymentId: w.paymentId });
  }
  await sleep(1500);
  const paid = new Set((await q(`select id from payments where id = any($1) and status = 'PAID'`, [refundables.map((r) => r.paymentId)])).map((r) => r.id));
  const refundOk = refundables.filter((r) => paid.has(r.paymentId));
  const used = new Set(refundOk.map((r) => r.paymentId));
  web = web.filter((w) => !used.has(w.paymentId)); // these are PAID now: not available for the fresh-webhook scenario
  write('pack-pay-webhooks.json', web);
  write('pack-pay-returns.json', ret);
  write('pack-pay-refundables.json', refundOk);
  console.log(`webhook pack ${web.length}, return pack ${ret.length}, refundables ${refundOk.length} (requested ${N_REFUNDABLES}; PAID confirmed in DB)`);
  write('pack-pay-invoices.json', []);
  console.log('invoice/renewal packs: NOT BUILT (billing-checkout and renewal scenarios will skip)');
}

await pg.end();
console.log(`packs written to ${path.relative(REPO, OUT)} (gitignored)`);
