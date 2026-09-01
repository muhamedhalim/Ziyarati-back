#!/usr/bin/env node
/**
 * Samples backend + database internals during a load run, so k6's client-side
 * numbers can be correlated with what the server was actually doing.
 *
 * k6 can only see latency and status codes. It cannot tell a slow query from a
 * saturated event loop from an exhausted connection pool — and those have
 * completely different fixes. This samples the three signals that separate them:
 *
 *   1. /api/v1/metrics (Prometheus, open when METRICS_TOKEN is unset in dev):
 *        nodejs_eventloop_lag_seconds_p99   <- CPU / event-loop saturation
 *        nodejs_heap_size_used_bytes        <- leak detection over a soak
 *        process_resident_memory_bytes
 *        process_cpu_user_seconds_total     <- CPU-seconds per request
 *        nodejs_active_handles_total
 *        db_queries_total                   <- queries per request
 *   2. pg_stat_activity: active / idle / idle-in-transaction / waiting counts.
 *      THE POOL CEILING IS 10 HERE (.env DB_POOL_MAX=10; code default is 15).
 *      If `active` never approaches it, the pool is NOT the bottleneck — which
 *      is exactly what five previous audit passes concluded.
 *   3. pg_stat_statements-free slow-query proxy: the longest-running current
 *      query, so a single pathological statement is visible.
 *
 * Usage:
 *   node tests/load/helpers/monitor.js --out tests/load/reports/monitor-sweep.json --interval 2000
 */
const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};

const OUT = opt('out', 'tests/load/reports/monitor.json');
const INTERVAL = Number(opt('interval', 2000));
const METRICS_URL = opt('metrics', 'http://127.0.0.1:3001/api/v1/metrics');
const PG_CONTAINER = opt('pg', 'ziyarati-perfaudit-postgres');
const PG_DB = opt('db', 'ziyarati_perf');

// Exact names as exposed by prom-client's collectDefaultMetrics in this app —
// note the lag percentiles are `nodejs_eventloop_lag_p99_seconds`, NOT
// `nodejs_eventloop_lag_seconds_p99`.
const WANTED = [
  'nodejs_eventloop_lag_p99_seconds',
  'nodejs_eventloop_lag_p90_seconds',
  'nodejs_eventloop_lag_mean_seconds',
  'nodejs_heap_size_used_bytes',
  'process_resident_memory_bytes',
  'process_cpu_user_seconds_total',
  'process_cpu_system_seconds_total',
  'process_cpu_seconds_total',
  'nodejs_active_handles_total',
];

function scrape() {
  return new Promise((resolve) => {
    http.get(METRICS_URL, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const out = {};
        let dbQueries = 0;
        for (const line of body.split('\n')) {
          if (line.startsWith('#') || !line.trim()) continue;
          const sp = line.lastIndexOf(' ');
          if (sp === -1) continue;
          const key = line.slice(0, sp);
          const val = Number(line.slice(sp + 1));
          const bare = key.split('{')[0];
          if (WANTED.includes(bare)) out[bare] = val;
          if (bare === 'db_queries_total' && !Number.isNaN(val)) dbQueries += val;
        }
        out.db_queries_total = dbQueries;
        resolve(out);
      });
    }).on('error', () => resolve({ error: 'metrics_unreachable' }));
  });
}

function pg() {
  const sql = `SELECT
      count(*) FILTER (WHERE state='active')               AS active,
      count(*) FILTER (WHERE state='idle')                 AS idle,
      count(*) FILTER (WHERE state='idle in transaction')  AS idle_in_tx,
      count(*) FILTER (WHERE wait_event_type='Lock')       AS waiting_on_lock,
      count(*)                                             AS total,
      -- FILTER binds to the AGGREGATE, so it must sit inside EXTRACT's argument,
      -- not after it (the latter is a syntax error).
      COALESCE(EXTRACT(EPOCH FROM max(now()-query_start) FILTER (WHERE state='active')),0) AS longest_active_s
    FROM pg_stat_activity WHERE datname='${PG_DB}';`;
  return new Promise((resolve) => {
    execFile('docker',
      ['exec', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', PG_DB, '-t', '-A', '-F', '|', '-c', sql],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve({ error: 'pg_unreachable' });
        const p = String(stdout).trim().split('|');
        resolve({
          active: Number(p[0]), idle: Number(p[1]), idle_in_tx: Number(p[2]),
          waiting_on_lock: Number(p[3]), total: Number(p[4]),
          longest_active_s: Number(p[5]),
        });
      });
  });
}

const samples = [];
let stopping = false;

async function tick() {
  if (stopping) return;
  const [m, p] = await Promise.all([scrape(), pg()]);
  samples.push({ t: new Date().toISOString(), metrics: m, pg: p });
  if (!stopping) setTimeout(tick, INTERVAL);
}

function finish() {
  if (stopping) return;
  stopping = true;

  // Derive the summary that actually answers "what saturated first".
  const num = (arr) => arr.filter((x) => typeof x === 'number' && !Number.isNaN(x));
  const lag = num(samples.map((s) => s.metrics.nodejs_eventloop_lag_p99_seconds));
  const heap = num(samples.map((s) => s.metrics.nodejs_heap_size_used_bytes));
  const rss = num(samples.map((s) => s.metrics.process_resident_memory_bytes));
  const active = num(samples.map((s) => s.pg.active));
  const idleTx = num(samples.map((s) => s.pg.idle_in_tx));
  const waits = num(samples.map((s) => s.pg.waiting_on_lock));
  const max = (a) => (a.length ? Math.max(...a) : null);
  const first = (a) => (a.length ? a[0] : null);
  const last = (a) => (a.length ? a[a.length - 1] : null);

  const report = {
    generatedAt: new Date().toISOString(),
    intervalMs: INTERVAL,
    sampleCount: samples.length,
    summary: {
      eventloop_lag_p99_max_s: max(lag),
      pg_active_connections_max: max(active),
      pg_idle_in_transaction_max: max(idleTx),
      pg_waiting_on_lock_max: max(waits),
      heap_first_bytes: first(heap),
      heap_last_bytes: last(heap),
      heap_growth_bytes: (first(heap) != null && last(heap) != null) ? last(heap) - first(heap) : null,
      rss_first_bytes: first(rss),
      rss_last_bytes: last(rss),
      rss_growth_bytes: (first(rss) != null && last(rss) != null) ? last(rss) - first(rss) : null,
      cpu_user_seconds_delta:
        (first(num(samples.map((s) => s.metrics.process_cpu_user_seconds_total))) != null)
          ? last(num(samples.map((s) => s.metrics.process_cpu_user_seconds_total)))
            - first(num(samples.map((s) => s.metrics.process_cpu_user_seconds_total)))
          : null,
      db_queries_delta:
        (first(num(samples.map((s) => s.metrics.db_queries_total))) != null)
          ? last(num(samples.map((s) => s.metrics.db_queries_total)))
            - first(num(samples.map((s) => s.metrics.db_queries_total)))
          : null,
    },
    samples,
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  const s = report.summary;
  console.log(`\nmonitor -> ${OUT}  (${samples.length} samples)`);
  console.log(`  event-loop lag p99 max : ${s.eventloop_lag_p99_max_s}s`);
  console.log(`  pg active conns max    : ${s.pg_active_connections_max}  (pool ceiling 10)`);
  console.log(`  pg idle-in-tx max      : ${s.pg_idle_in_transaction_max}`);
  console.log(`  pg waiting-on-lock max : ${s.pg_waiting_on_lock_max}`);
  console.log(`  heap growth            : ${Math.round((s.heap_growth_bytes || 0) / 1048576)} MB`);
  console.log(`  rss growth             : ${Math.round((s.rss_growth_bytes || 0) / 1048576)} MB`);
  console.log(`  cpu-user delta         : ${s.cpu_user_seconds_delta}s`);
  console.log(`  db queries delta       : ${s.db_queries_delta}`);
  process.exit(0);
}

process.on('SIGINT', finish);
process.on('SIGTERM', finish);
const durationMs = Number(opt('duration', 0));
if (durationMs > 0) setTimeout(finish, durationMs);

tick();
