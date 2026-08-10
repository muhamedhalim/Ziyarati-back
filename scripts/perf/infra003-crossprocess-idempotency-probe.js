'use strict';

/**
 * PERF-INFRA-003 verification — payment idempotency ACROSS cluster workers.
 *
 * The existing `payment-idempotency.e2e-spec.ts` proves the double-submit
 * guard (a Postgres UNIQUE constraint on `idempotency_key`, races resolved by
 * catching the unique-violation and re-reading the winning row — see
 * `payment.service.ts`) is correct under CONCURRENT requests, but that suite
 * runs one in-process Nest app, so every request is handled by the SAME
 * process. This probe fires the identical race against a REAL running
 * cluster (`API_CLUSTER_WORKERS>1`), so the N concurrent requests can land on
 * N DIFFERENT OS processes — the one new risk surface clustering could have
 * introduced. Since the guard is DB-level (not in-process memory), it should
 * be exactly as correct across processes as within one; this proves it,
 * rather than asserting it from a code read.
 *
 * Not wired into any npm script or CI — standalone, run directly with node
 * against an already-running, already-authenticated-reachable stack.
 *
 * Usage:
 *   node scripts/perf/infra003-crossprocess-idempotency-probe.js --port=3001 \
 *     --pg=postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf
 */

const { Client } = require('pg');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const PORT = Number(args.port || 3001);
const API_BASE = `http://127.0.0.1:${PORT}`;
const PG_CONN = args.pg || 'postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf';
const LOGIN_EMAIL = args.email || 'perf.owner.t0@t1.local.test';
const LOGIN_PASSWORD = args.password || 'PerfT1Primary123!';
const CONCURRENCY = Number(args.n || 12);

async function login() {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookieHeader) throw new Error('login succeeded but no Set-Cookie header returned');
  // Double-submit CSRF (csrf.guard.ts): the SPA-readable `csrf_token` cookie
  // must be echoed back as the `X-CSRF-Token` header on state-changing
  // requests. Cookie-auth clients (this probe) need both; a header-bearer
  // client would skip this.
  const csrfMatch = /csrf_token=([^;]+)/.exec(cookieHeader);
  const csrfToken = csrfMatch ? csrfMatch[1] : null;
  if (!csrfToken) throw new Error('login succeeded but no csrf_token cookie was set');
  return { cookieHeader, csrfToken };
}

async function pickCustomer(cookieHeader) {
  const res = await fetch(`${API_BASE}/api/v1/crm/customers?limit=1`, { headers: { cookie: cookieHeader } });
  if (!res.ok) throw new Error(`customers list failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const customer = Array.isArray(body) ? body[0] : body?.data?.[0];
  if (!customer?.id) throw new Error(`could not resolve a customer id from response shape: ${JSON.stringify(body).slice(0, 200)}`);
  return customer.id;
}

async function createPayment(cookieHeader, csrfToken, amount, customerId) {
  const res = await fetch(`${API_BASE}/api/v1/payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({ amount, customerId }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  console.log(`[idempotency-probe] api=${API_BASE} concurrency=${CONCURRENCY}`);
  const { cookieHeader, csrfToken } = await login();
  console.log('[idempotency-probe] logged in');
  const customerId = await pickCustomer(cookieHeader);
  // Distinctive, out-of-range-for-real-data amount so the DB check below can
  // find exactly this probe's own row(s) without colliding with T1 seed data.
  const amount = 917.13;
  console.log(`[idempotency-probe] customerId=${customerId} amount=${amount}`);

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => createPayment(cookieHeader, csrfToken, amount, customerId)),
  );

  const okResults = results.filter((r) => r.status === 201);
  if (okResults.length < CONCURRENCY) {
    const failed = results.find((r) => r.status !== 201);
    console.log('[idempotency-probe] sample non-201 response:', failed?.status, JSON.stringify(failed?.body).slice(0, 300));
  }
  const paymentIds = new Set(okResults.map((r) => r.body?.payment?.id).filter(Boolean));

  console.log(`[idempotency-probe] ${okResults.length}/${CONCURRENCY} requests returned 201`);
  console.log(`[idempotency-probe] distinct payment ids observed across all responses: ${paymentIds.size}`, [...paymentIds]);

  const client = new Client({ connectionString: PG_CONN });
  await client.connect();
  const { rows } = await client.query(
    `SELECT id, "customerId", amount, status, created_at FROM payments
     WHERE "customerId" = $1 AND amount = $2 ORDER BY created_at`,
    [customerId, amount],
  );
  await client.end();

  console.log(`[idempotency-probe] DB rows for this customer+amount: ${rows.length}`);
  for (const r of rows) console.log('  ', r.id, r.status, r.created_at);

  const pass = okResults.length === CONCURRENCY && paymentIds.size === 1 && rows.length === 1;
  console.log(pass
    ? `[idempotency-probe] PASS — ${CONCURRENCY} concurrent cross-process requests (same customer+amount, no client idempotencyKey) produced exactly ONE payment row, every caller observed the same id.`
    : `[idempotency-probe] FAIL — expected exactly 1 payment row and 1 distinct id across ${CONCURRENCY} concurrent requests.`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error('[idempotency-probe] ERROR', err);
  process.exitCode = 1;
});
