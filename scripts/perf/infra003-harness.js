'use strict';

/**
 * PERF-INFRA-003 harness — measures whether Node.js single-process
 * concurrency (not the DB pool) is the platform's real bottleneck under
 * load, and whether process-level scaling materially helps.
 *
 * Isolated `ziyarati-perfaudit-*` stack only (5434/6380). Never imported by
 * src/ — standalone, run directly with node.
 *
 * For each requested concurrency level, against a chosen endpoint:
 *   - fires N concurrent requests, computes wall latency p50/p95/p99/min/max
 *     and throughput (n / wall-clock seconds)
 *   - scrapes the API's own Prometheus /metrics before and after the burst
 *     (nodejs_eventloop_lag_seconds*, process_cpu_{user,system}_seconds_total,
 *     nodejs_active_handles_total) and reports the deltas
 *   - polls pg_stat_activity throughout the burst (peak/mean active
 *     connections, same technique as db001-pool-harness.js)
 *
 * Usage:
 *   node scripts/perf/infra003-harness.js --port=3001 --label=single-process \
 *     --endpoint=appointments --concurrency=10,25,50 \
 *     --pg=postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf
 */

const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const PORT = Number(args.port || 3001);
const API_BASE = `http://127.0.0.1:${PORT}`;
const PG_CONN = args.pg || 'postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf';
const LABEL = args.label || 'run';
const CONCURRENCY_LEVELS = String(args.concurrency || '10,25,50')
  .split(',')
  .map((n) => Number(n.trim()));
const ENDPOINT_NAME = args.endpoint || 'appointments';
const LOGIN_EMAIL = args.email || 'perf.owner.t0@t1.local.test';
const LOGIN_PASSWORD = args.password || 'PerfT1Primary123!';

const ENDPOINTS = {
  readiness: { path: '/api/v1/system/health/readiness', auth: false },
  appointments: { path: '/api/v1/appointments?limit=50', auth: true },
  availability: null, // resolved at runtime — needs a real branch/staff id
};

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

/** Resolves a real branchId/staffId pair for the logged-in tenant, for /availability. */
async function resolveAvailabilityTarget(cookieHeader) {
  const branches = await fetch(`${API_BASE}/api/v1/branches`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  // /branches returns a plain array; /staff (below) returns { data: [...] } — different shapes, confirmed live.
  const branchId = Array.isArray(branches) ? branches[0]?.id : branches?.data?.[0]?.id;
  const staff = await fetch(`${API_BASE}/api/v1/staff?branchId=${branchId}&limit=1`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
  const staffId = staff?.data?.[0]?.id;
  if (!branchId || !staffId) throw new Error(`could not resolve a branch/staff pair (branchId=${branchId}, staffId=${staffId})`);
  const dateStr = new Date().toISOString().slice(0, 10);
  // AvailabilityController is mounted at 'scheduling/availability' — confirmed
  // via source read, not assumed (a first version of this script guessed
  // '/api/v1/availability' and silently measured 404s — caught and fixed
  // during PERF-BE-005 revalidation, all earlier availability numbers under
  // this wrong path were discarded and re-measured).
  return `/api/v1/scheduling/availability/windows?branchId=${branchId}&staffId=${staffId}&date=${dateStr}`;
}

async function fireOne(url, cookieHeader) {
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(`${API_BASE}${url}`, cookieHeader ? { headers: { cookie: cookieHeader } } : undefined);
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    await res.text().catch(() => {});
    return { ms, ok: res.ok, status: res.status };
  } catch (err) {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    return { ms, ok: false, status: 0, error: String(err && err.message) };
  }
}

async function burst(url, cookieHeader, n) {
  const t0 = Date.now();
  const promises = Array.from({ length: n }, () => fireOne(url, cookieHeader));
  const results = await Promise.all(promises);
  const wallMs = Date.now() - t0;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok);
  return {
    n,
    wallMs,
    throughputPerSec: Number((n / (wallMs / 1000)).toFixed(2)),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    minMs: latencies[0],
    maxMs: latencies[latencies.length - 1],
    errorCount: errors.length,
    errors: errors.slice(0, 3),
  };
}

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
          SELECT state, count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
          GROUP BY state
        `);
        const row = { active: 0, idle: 0, idle_in_transaction: 0, other: 0, t: Date.now() };
        for (const r of res.rows) {
          if (r.state === 'active') row.active = r.n;
          else if (r.state === 'idle') row.idle = r.n;
          else if (r.state === 'idle in transaction' || r.state === 'idle in transaction (aborted)') row.idle_in_transaction += r.n;
          else row.other += r.n;
        }
        samples.push(row);
      } catch {
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
function meanOf(samples, key) {
  if (samples.length === 0) return 0;
  return Number((samples.reduce((sum, s) => sum + (s[key] || 0), 0) / samples.length).toFixed(2));
}

/** Parses the subset of prom-client's text exposition format this harness needs. */
function parseMetrics(text) {
  const get = (name, labelMatch) => {
    const lines = text.split('\n').filter((l) => l.startsWith(name) && !l.startsWith('#'));
    for (const line of lines) {
      if (labelMatch && !line.includes(labelMatch)) continue;
      const m = line.match(/\s([0-9.eE+-]+)\s*$/);
      if (m) return Number(m[1]);
    }
    return null;
  };
  return {
    eventLoopLagMeanSeconds: get('nodejs_eventloop_lag_seconds ') ?? get('nodejs_eventloop_lag_seconds{'),
    eventLoopLagP99Seconds: get('nodejs_eventloop_lag_p99_seconds'),
    eventLoopLagMaxSeconds: get('nodejs_eventloop_lag_max_seconds'),
    cpuUserSeconds: get('process_cpu_user_seconds_total'),
    cpuSystemSeconds: get('process_cpu_system_seconds_total'),
    activeHandles: get('nodejs_active_handles_total'),
    residentMemoryBytes: get('process_resident_memory_bytes'),
  };
}

async function scrapeMetrics() {
  const res = await fetch(`${API_BASE}/api/v1/metrics`);
  if (!res.ok) return null;
  const text = await res.text();
  return parseMetrics(text);
}

function diffMetrics(before, after) {
  if (!before || !after) return null;
  return {
    cpuSecondsUsed: Number(((after.cpuUserSeconds + after.cpuSystemSeconds) - (before.cpuUserSeconds + before.cpuSystemSeconds)).toFixed(4)),
    eventLoopLagMeanSecondsAfter: after.eventLoopLagMeanSeconds,
    eventLoopLagP99SecondsAfter: after.eventLoopLagP99Seconds,
    eventLoopLagMaxSecondsAfter: after.eventLoopLagMaxSeconds,
    residentMemoryBytesAfter: after.residentMemoryBytes,
  };
}

async function main() {
  console.log(`[infra003-harness] label=${LABEL} api=${API_BASE} endpoint=${ENDPOINT_NAME} concurrency=${CONCURRENCY_LEVELS.join(',')}`);

  const cookieHeader = ENDPOINTS[ENDPOINT_NAME]?.auth === false ? null : await login();
  console.log('[infra003-harness] logged in', !!cookieHeader);

  let url;
  if (ENDPOINT_NAME === 'availability') {
    url = await resolveAvailabilityTarget(cookieHeader);
    console.log('[infra003-harness] resolved availability url', url);
  } else {
    url = ENDPOINTS[ENDPOINT_NAME].path;
  }

  // Warm-up, unmeasured.
  await burst(url, cookieHeader, 3);
  await new Promise((r) => setTimeout(r, 500));

  const levels = [];
  for (const n of CONCURRENCY_LEVELS) {
    const metricsBefore = await scrapeMetrics();
    const poller = startPoolPoller(50);
    const result = await burst(url, cookieHeader, n);
    const samples = await poller.stop();
    const metricsAfter = await scrapeMetrics();

    levels.push({
      concurrency: n,
      ...result,
      poolPeakActive: peakOf(samples, 'active'),
      poolMeanActive: meanOf(samples, 'active'),
      poolPeakIdleInTx: peakOf(samples, 'idle_in_transaction'),
      poolSampleCount: samples.length,
      metricsBefore,
      metricsAfter,
      metricsDelta: diffMetrics(metricsBefore, metricsAfter),
    });
    console.log(`[infra003-harness] n=${n} p50=${result.p50Ms}ms p95=${result.p95Ms}ms throughput=${result.throughputPerSec}/s poolPeakActive=${peakOf(samples, 'active')} cpuUsed=${diffMetrics(metricsBefore, metricsAfter)?.cpuSecondsUsed}s`);

    await new Promise((r) => setTimeout(r, 1000)); // let the pool/event loop settle between levels
  }

  const output = {
    label: LABEL,
    endpoint: ENDPOINT_NAME,
    url,
    timestamp: new Date().toISOString(),
    port: PORT,
    levels,
  };

  const outDir = path.join(__dirname, 'evidence', 'infra003-stageb');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${LABEL}-${ENDPOINT_NAME}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`[infra003-harness] wrote ${outFile}`);
}

main().catch((err) => {
  console.error('[infra003-harness] FAILED', err);
  process.exit(1);
});
