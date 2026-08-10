'use strict';

/**
 * PERF-DB-001 Stage B harness — isolated `ziyarati-perf-db001` stack only.
 *
 * Reproduces T074's N=10-vs-N=25 concurrent burst against
 * GET /api/v1/appointments?limit=50 (EV-database-T074-pool-saturation),
 * plus the connection-lifecycle metrics T074 itself never captured live:
 * active/idle/waiting pg_stat_activity counts polled during the burst,
 * per-request latency percentiles, error/timeout counts, and process CPU.
 *
 * Never imported by src/ — standalone, run directly with node.
 *
 * Usage:
 *   node scripts/perf/db001-pool-harness.js --phase=before --tag=owner-t0
 *   node scripts/perf/db001-pool-harness.js --phase=after --tag=owner-t0
 */

const { Client } = require('pg');

const API_BASE = process.env.PERF_API_BASE || 'http://127.0.0.1:3011';
const PG_CONN = process.env.PERF_PG_CONN || 'postgres://postgres:postgres@127.0.0.1:5435/ziyarati_perf_db001';
const LOGIN_EMAIL = process.env.PERF_LOGIN_EMAIL || 'perf.owner.t0@t2.local.test';
const LOGIN_PASSWORD = process.env.PERF_LOGIN_PASSWORD || 'PerfT2Primary123!';
const ENDPOINT = '/api/v1/appointments?limit=50';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const phase = args.phase || 'before';
const tag = args.tag || 'run';

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
  if (!res.ok) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.raw?.()['set-cookie'] || [];
  const cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookieHeader) throw new Error('login succeeded but no Set-Cookie header returned');
  return cookieHeader;
}

async function fireOne(cookieHeader) {
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(`${API_BASE}${ENDPOINT}`, {
      headers: { cookie: cookieHeader },
    });
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    if (!res.ok) {
      await res.text().catch(() => {});
      return { ms, ok: false, status: res.status };
    }
    await res.json();
    return { ms, ok: true, status: res.status };
  } catch (err) {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    return { ms, ok: false, status: 0, error: String(err && err.message) };
  }
}

async function burst(cookieHeader, n) {
  const promises = Array.from({ length: n }, () => fireOne(cookieHeader));
  const results = await Promise.all(promises);
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok);
  return {
    n,
    medianMs: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    minMs: latencies[0],
    maxMs: latencies[latencies.length - 1],
    errorCount: errors.length,
    errors: errors.slice(0, 5),
    raw: latencies,
  };
}

/** Polls pg_stat_activity every `intervalMs` until `stop()` is called; returns peak snapshot. */
function startPoolPoller(intervalMs) {
  const client = new Client({ connectionString: PG_CONN });
  const samples = [];
  let stopped = false;
  const connectPromise = client.connect();

  const loop = async () => {
    await connectPromise;
    while (!stopped) {
      try {
        const res = await client.query(`
          SELECT state, count(*)::int AS n
          FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
          GROUP BY state
        `);
        const row = { active: 0, idle: 0, idle_in_transaction: 0, waiting: 0, other: 0, t: Date.now() };
        for (const r of res.rows) {
          if (r.state === 'active') row.active = r.n;
          else if (r.state === 'idle') row.idle = r.n;
          else if (r.state === 'idle in transaction' || r.state === 'idle in transaction (aborted)') row.idle_in_transaction += r.n;
          else if (r.state === null) row.other += r.n;
          else row.other += r.n;
        }
        const waitRes = await client.query(`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Client' AND wait_event = 'ClientRead'
        `);
        samples.push(row);
      } catch (e) {
        // ignore transient errors during poll
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  const loopPromise = loop();

  return {
    async stop() {
      stopped = true;
      await loopPromise;
      await client.end();
      return samples;
    },
  };
}

function peakOf(samples, key) {
  return samples.reduce((max, s) => Math.max(max, s[key] || 0), 0);
}

async function main() {
  console.log(`[db001-harness] phase=${phase} tag=${tag} api=${API_BASE} pg=${PG_CONN.replace(/:[^:@]+@/, ':***@')}`);

  const cookieHeader = await login();
  console.log('[db001-harness] logged in, cookie length', cookieHeader.length);

  // Warm-up (not measured) — avoid counting first-connection/JIT overhead.
  await burst(cookieHeader, 3);
  await new Promise((r) => setTimeout(r, 500));

  const cpuBefore10 = process.cpuUsage();
  const poller10 = startPoolPoller(50);
  const t10Start = Date.now();
  const n10 = await burst(cookieHeader, 10);
  const t10Wall = Date.now() - t10Start;
  const samples10 = await poller10.stop();

  await new Promise((r) => setTimeout(r, 1000));

  const poller25 = startPoolPoller(50);
  const t25Start = Date.now();
  const n25 = await burst(cookieHeader, 25);
  const t25Wall = Date.now() - t25Start;
  const samples25 = await poller25.stop();

  const result = {
    phase,
    tag,
    timestamp: new Date().toISOString(),
    endpoint: ENDPOINT,
    n10: { ...n10, wallMs: t10Wall, poolPeakActive: peakOf(samples10, 'active'), poolPeakIdleInTx: peakOf(samples10, 'idle_in_transaction'), sampleCount: samples10.length },
    n25: { ...n25, wallMs: t25Wall, poolPeakActive: peakOf(samples25, 'active'), poolPeakIdleInTx: peakOf(samples25, 'idle_in_transaction'), sampleCount: samples25.length },
    deltaPercent: n10.medianMs ? Math.round(((n25.medianMs - n10.medianMs) / n10.medianMs) * 10000) / 100 : null,
  };

  console.log(JSON.stringify(result, null, 2));

  const fs = require('node:fs');
  const path = require('node:path');
  const outDir = path.join(__dirname, 'evidence', 'db001-stageb');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${phase}-${tag}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`[db001-harness] wrote ${outFile}`);
}

main().catch((err) => {
  console.error('[db001-harness] FAILED', err);
  process.exit(1);
});
