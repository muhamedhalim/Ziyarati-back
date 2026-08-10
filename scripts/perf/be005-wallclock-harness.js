'use strict';

/**
 * PERF-BE-005 revalidation — real before/after WALL-CLOCK measurement (not
 * just the structural Promise.all count) for the flows PERF-BE-005 changed.
 *
 * Fires N SEQUENTIAL (not concurrent) single requests against one endpoint,
 * to isolate per-request latency from queueing effects (PERF-INFRA-003 is
 * the concurrency story; this is the per-request-cost story). Reports
 * mean/median/p95/min/max.
 *
 * Usage:
 *   node scripts/perf/be005-wallclock-harness.js --port=3001 --label=after \
 *     --endpoint=availability --n=40
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const PORT = Number(args.port || 3001);
const API_BASE = `http://127.0.0.1:${PORT}`;
const LABEL = args.label || 'run';
const N = Number(args.n || 40);
const ENDPOINT_NAME = args.endpoint || 'availability';
const LOGIN_EMAIL = args.email || 'perf.owner.t0@t1.local.test';
const LOGIN_PASSWORD = args.password || 'PerfT1Primary123!';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function login() {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function resolveTarget(cookieHeader, name) {
  if (name === 'availability') {
    const branches = await fetch(`${API_BASE}/api/v1/branches`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
    const branchId = Array.isArray(branches) ? branches[0]?.id : branches?.data?.[0]?.id;
    const staff = await fetch(`${API_BASE}/api/v1/staff?branchId=${branchId}&limit=1`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
    const staffId = staff?.data?.[0]?.id;
    const dateStr = new Date().toISOString().slice(0, 10);
    // AvailabilityController is mounted at 'scheduling/availability' — confirmed
    // via source read (src/modules/scheduling/availability.controller.ts), not
    // assumed. windows() is the exact method PERF-BE-005 changed
    // ([positive, busy] = await Promise.all([...])).
    return `/api/v1/scheduling/availability/windows?branchId=${branchId}&staffId=${staffId}&date=${dateStr}`;
  }
  if (name === 'transaction') {
    const list = await fetch(`${API_BASE}/api/v1/platform/finance/transactions?limit=1`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
    const id = list?.data?.[0]?.id ?? list?.[0]?.id;
    if (!id) throw new Error('no transaction found to target — is the platform-finance data seeded?');
    return `/api/v1/platform/finance/transactions/${id}`;
  }
  throw new Error(`unknown endpoint ${name}`);
}

async function main() {
  const cookieHeader = await login();
  const url = await resolveTarget(cookieHeader, ENDPOINT_NAME);
  console.log(`[be005-wallclock] label=${LABEL} endpoint=${ENDPOINT_NAME} url=${url} n=${N}`);

  // Warm-up, unmeasured.
  for (let i = 0; i < 5; i++) {
    await fetch(`${API_BASE}${url}`, { headers: { cookie: cookieHeader } }).then((r) => r.text());
  }

  const samples = [];
  for (let i = 0; i < N; i++) {
    const start = process.hrtime.bigint();
    const res = await fetch(`${API_BASE}${url}`, { headers: { cookie: cookieHeader } });
    await res.text();
    const end = process.hrtime.bigint();
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    samples.push(Number(end - start) / 1e6);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const result = {
    label: LABEL,
    endpoint: ENDPOINT_NAME,
    url,
    n: N,
    meanMs: Number(mean.toFixed(3)),
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
  console.log(JSON.stringify(result, null, 2));

  const fs = require('node:fs');
  const path = require('node:path');
  const outDir = path.join(__dirname, 'evidence', 'be005-stageb');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${LABEL}-${ENDPOINT_NAME}-${Date.now()}.json`), JSON.stringify({ ...result, samples }, null, 2));
}

main().catch((err) => {
  console.error('[be005-wallclock] FAILED', err);
  process.exit(1);
});
