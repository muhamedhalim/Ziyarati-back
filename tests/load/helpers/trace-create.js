/**
 * Per-request DB cost probe for POST /appointments.
 *
 * Answers two questions with numbers instead of a static read of the code:
 *   1. how many SQL statements does ONE booking execute?  (db_queries_total
 *      delta, labelled by the Express route pattern — every statement issued
 *      during the request shares the request's AsyncLocalStorage context,
 *      including the ones AvailabilityService runs on its OWN pooled
 *      connections rather than the transaction's)
 *   2. how long does it take end-to-end, with the API otherwise idle?
 *
 * Run against an IDLE API — a concurrent load run makes the delta meaningless.
 *
 *   TEST_PASSWORD=... node tests/load/helpers/trace-create.js
 *
 * Env: BASE_URL (default http://127.0.0.1:3001)
 *      TEST_EMAIL (default perf.owner.t0@t1.local.test)
 *      TEST_PASSWORD (required — never defaulted, never printed)
 *      SAMPLES (default 5)
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const EMAIL = process.env.TEST_EMAIL || 'perf.owner.t0@t1.local.test';
const PASSWORD = process.env.TEST_PASSWORD;
const SAMPLES = Number(process.env.SAMPLES || 5);

if (!PASSWORD) {
  console.error('TEST_PASSWORD is required (never hardcoded, never logged).');
  process.exit(1);
}

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorb(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function req(method, path, body) {
  const headers = { cookie: cookieHeader() };
  if (body) headers['content-type'] = 'application/json';
  const csrf = jar.get('csrf_token');
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  absorb(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

/** db_queries_total for one route label, or the sum across all labels. */
async function dbQueries(routeSuffix) {
  const res = await fetch(`${BASE}/api/v1/metrics`);
  const text = await res.text();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('db_queries_total{')) continue;
    const m = /^db_queries_total\{route="([^"]*)"\}\s+([0-9.]+)$/.exec(line.trim());
    if (!m) continue;
    if (routeSuffix && m[1] !== routeSuffix) continue;
    total += Number(m[2]);
  }
  return total;
}

async function poolStats() {
  // pg_stat_activity is not reachable from here; the monitor script covers it.
  return null;
}

function pick(res, key) {
  const b = res.body;
  const list = Array.isArray(b) ? b : (b && Array.isArray(b[key]) ? b[key] : []);
  return list;
}

(async () => {
  const login = await req('POST', '/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200 && login.status !== 201) {
    console.error(`login failed: ${login.status}`);
    process.exit(1);
  }

  const branches = pick(await req('GET', '/api/v1/branches?limit=10'), 'data');
  if (!branches.length) { console.error('no branches'); process.exit(1); }

  // A branch/staff pair that actually works together — otherwise the booking is
  // refused for a reason that has nothing to do with what we are measuring.
  let branchId = null; let staffId = null;
  for (const b of branches) {
    const staff = pick(await req('GET', `/api/v1/staff?branchId=${b.id}&limit=20`), 'data');
    if (staff.length) { branchId = b.id; staffId = staff[0].id; break; }
  }
  if (!staffId) { console.error('no branch/staff pair'); process.exit(1); }

  const customers = pick(await req('GET', '/api/v1/crm/customers?page=1&limit=5'), 'data');
  const services = pick(await req('GET', '/api/v1/services/lookup'), 'data');
  if (!customers.length || !services.length) { console.error('no customer/service'); process.exit(1); }

  const created = [];
  const samples = [];

  // Same slot geometry the k6 write flow uses: inside the seeded 08:00-20:00
  // Riyadh shift, scattered far enough apart that samples never collide.
  const SHIFT_START_UTC_H = 5;
  const base = new Date();
  base.setUTCHours(SHIFT_START_UTC_H, 0, 0, 0);

  for (let i = 0; i < SAMPLES; i++) {
    const start = new Date(base.getTime());
    start.setUTCDate(start.getUTCDate() + 400 + i * 3);
    const end = new Date(start.getTime() + 15 * 60_000);

    const before = await dbQueries('/api/v1/appointments');
    const t0 = Date.now();
    const res = await req('POST', '/api/v1/appointments', {
      branchId, staffId, customerId: customers[i % customers.length].id,
      serviceIds: [services[0].id],
      startAt: start.toISOString(), endAt: end.toISOString(),
      notes: 'k6-load-test',
    });
    const ms = Date.now() - t0;
    const after = await dbQueries('/api/v1/appointments');

    if (res.status === 201) created.push(res.body.id);
    samples.push({ status: res.status, ms, queries: after - before });
  }

  const ok = samples.filter((s) => s.status === 201);
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };

  console.log('\nPOST /api/v1/appointments — single-request cost (idle API)');
  console.log('  samples          :', samples.length, `(created ${ok.length})`);
  console.log('  statuses         :', samples.map((s) => s.status).join(', '));
  console.log('  SQL statements   :', samples.map((s) => s.queries).join(', '),
    `  median ${med(ok.map((s) => s.queries))}`);
  console.log('  latency ms       :', samples.map((s) => s.ms).join(', '),
    `  median ${med(ok.map((s) => s.ms))}`);
  console.log('\n  created ids (delete with data/cleanup.sql):', created.length);
  console.log();
})().catch((e) => { console.error(e.message); process.exit(1); });
