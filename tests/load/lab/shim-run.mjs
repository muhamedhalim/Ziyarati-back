// CHILD process of shim-check.mjs: run ONE scenario file, or ONE persona VU, under the k6 shim.
// Prints a single JSON line. Not meant to be run by hand.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [, , target, vuArg, ticksArg] = process.argv;
const LOAD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.__LT = { metrics: new Map(), requests: [], checkErrors: [], wsSent: [], scenarioName: 'steady', startTime: Date.now(), iter: 0 };
globalThis.__VU = Number(vuArg || 1);
globalThis.__ITER = 0;
globalThis.__ENV = Object.assign({
  BASE_URL: 'http://127.0.0.1:3101', LT_THINK_MS: '1', LT_TICK_S: '0', LT_TAP_SECRET: 'sk_test_x', LT_META_APP_SECRET: 'x',
  LT_LOGIN_PASSWORD: 'x', TEST_PASSWORD: 'x', LT_AI: 'true', LT_SKIP_PREFLIGHT: 'true', LT_DATA_DIR: '/shim-data',
}, JSON.parse(process.env.SHIM_ENV || '{}'));

// ---- synthetic data: sessions + packs, served through the shimmed open()
const ID = '11111111-1111-4111-8111-111111111111';
const perm = ['analytics.reports.read', 'analytics.dashboard.read', 'audit.read', 'appointments.update', 'staff.read_own'];
const mk = (role, i, cls) => ({
  userId: ID, email: `${role}${i}@x`, role, tenantId: `t${i}`, tenantIndex: i, class: cls, permissions: perm, access: 'AT', csrf: 'CT',
  branchIds: [ID], pairs: [{ branchId: ID, staffIds: [ID, ID] }], staffIds: [ID], customerIds: [ID, ID], customerCount: 400, serviceIds: [ID],
  queueIdx: 0, probeAppointmentId: ID, ownStaffId: ID,
});
const sessions = [];
const index = { count: 0, tenantCount: 3, byRole: {}, hotByRole: {}, ownerByTenant: {}, hotTenantId: 't0' };
for (const role of ['owner', 'manager', 'receptionist', 'doctor', 'nurse', 'super_admin']) {
  for (let i = 0; i < 3; i++) {
    const s = mk(role, i, i === 0 ? 'hot' : 'normal');
    const n = sessions.push(s) - 1;
    (index.byRole[role] = index.byRole[role] || []).push(n);
    if (i === 0) (index.hotByRole[role] = index.hotByRole[role] || []).push(n);
    if (role === 'owner') index.ownerByTenant[`t${i}`] = n;
  }
}
index.count = sessions.length;
const files = {
  'sessions.json': { sessions, index },
  'pack-queue.json': [{ tenantId: 't0', branchId: ID, appts: [ID, ID, ID] }],
  'pack-marketplace.json': [{ clinicSlugs: ['c'], doctorSlugs: ['d'], specialtySlugs: ['s'], serviceRoutes: [{ c: 'c', s: 's' }], cityIds: [ID] }],
  'pack-wa.json': [{ phoneNumberId: 'lt-pn-1' }],
  'pack-auth.json': [{ email: 'a@x' }], 'pack-auth-bad.json': [{ email: 'b@x' }], 'pack-auth-lock.json': [{ email: 'l@x' }],
  'pack-partner.json': [{ tenantId: 't0', apiKey: 'zt_x', connectionId: ID, branchId: ID, staffId: ID, customerId: ID, endpointId: ID, endpointSecret: 'sec' }],
  'pack-pay-links.json': [{ token: 'tok_0123456789abcdef' }],
  'pack-pay-webhooks.json': [{ chargeId: 'chg_1', paymentId: ID, amount: 150, currency: 'SAR' }],
  'pack-pay-returns.json': [{ chargeId: 'chg_2' }],
  'pack-pay-invoices.json': [{ tenantId: 't0', invoiceId: ID }],
  'pack-pay-refundables.json': [{ tenantId: 't0', paymentId: ID }],
};
globalThis.open = (p) => {
  const name = String(p).split('/').pop();
  if (name === 'services.xlsx') return new ArrayBuffer(8);
  if (!(name in files) || process.env.SHIM_NO_DATA === '1') throw new Error(`ENOENT ${name}`);
  return JSON.stringify(files[name]);
};

const out = { target, vu: globalThis.__VU, ok: true, errors: [], executed: [] };
try {
  const mod = await import(pathToFileURL(path.join(LOAD, target)).href);
  if (target.startsWith('scenarios/')) {
    const opts = mod.options || {};
    const sc = opts.scenarios || {};
    if (!Object.keys(sc).length) out.errors.push('no scenarios defined');
    for (const [name, def] of Object.entries(sc)) {
      const fnName = def.exec || 'default';
      if (typeof mod[fnName] !== 'function') { out.errors.push(`scenario "${name}": exec "${fnName}" is not an exported function`); continue; }
      if (!def.executor) out.errors.push(`scenario "${name}": no executor`);
      if (def.executor === 'constant-arrival-rate' && !(def.rate > 0 && def.duration && def.preAllocatedVUs && def.maxVUs)) out.errors.push(`scenario "${name}": arrival-rate fields missing`);
      if (def.executor === 'ramping-vus' && !(Array.isArray(def.stages) && def.stages.length)) out.errors.push(`scenario "${name}": no stages`);
      if (def.executor === 'constant-vus' && !(def.vus > 0 && def.duration)) out.errors.push(`scenario "${name}": vus/duration missing`);
      globalThis.__LT.scenarioName = name;
      try { await mod[fnName](); out.executed.push(name); } catch (e) { out.errors.push(`scenario "${name}" exec ${fnName}: ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); }
    }
    for (const t of Object.keys(opts.thresholds || {})) if (!/^[a-zA-Z_]\w*(\{[^}]+\})?$/.test(t)) out.errors.push(`threshold key looks invalid: ${t}`);
    if (typeof mod.handleSummary !== 'function') out.errors.push('no handleSummary');
    else {
      const data = { metrics: {}, state: { testRunDurationMs: 1000 } };
      for (const [n, m] of globalThis.__LT.metrics) data.metrics[n] = { type: m.kind, values: { count: m.adds, rate: 0 } };
      try {
        const s = mod.handleSummary(data);
        if (!s || typeof s !== 'object' || !Object.keys(s).some((k) => k.startsWith('/reports/'))) out.errors.push('handleSummary returned no /reports file');
      } catch (e) { out.errors.push(`handleSummary: ${e.message}`); }
    }
  } else if (target === 'flows/campaign.js') {
    const ticks = Number(ticksArg || 6);
    // Fake clock: each tick is 4 simulated seconds, so the 3 s queue poll, the 30 s bell and the
    // think-time actions all come due (real ticks run in microseconds and would never fire a timer).
    const t0 = Date.now(); let k = 0;
    const realNow = Date.now;
    Date.now = () => t0 + k * 4000;
    for (let i = 0; i < ticks; i++) { k = i; globalThis.__ITER = i; mod.personaTick(); }
    Date.now = realNow;
    out.executed.push(`personaTick x${ticks} (persona ${mod.personaOf(globalThis.__VU)})`);
  }
  out.metrics = globalThis.__LT.metrics.size;
  out.requests = globalThis.__LT.requests.length;
  out.paths = [...new Set(globalThis.__LT.requests.map((r) => `${r.method} ${r.url.split('?')[0]}`))];
  // A request to ".../undefined" or ".../null" means a flow interpolated a missing value; real k6
  // would send it happily and the server would answer 4xx, silently polluting the error rate.
  for (const p of out.paths) if (/undefined|\/null\b|\[object|NaN/.test(p)) out.errors.push(`request path contains a missing value: ${p}`);
  const ce = [...new Set(globalThis.__LT.checkErrors)].slice(0, 5);
  for (const e of ce) out.errors.push(`check/metric error: ${e}`);
} catch (e) { out.errors.push(`import/exec failed: ${String(e.stack).split('\n').slice(0, 4).join(' | ')}`); }
out.ok = out.errors.length === 0;
console.log(JSON.stringify(out));
