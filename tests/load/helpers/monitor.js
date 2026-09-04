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
/**
 * Value option. The `next token` MUST be rejected when it is itself a flag:
 * `--redis --gen --locks` are booleans, so a naive `args[i + 1]` made
 * `opt('redis', ...)` return the string `--gen`, and every Redis sample of a
 * 13-minute run then ran `docker exec --gen ...` and failed. The flag was
 * silently redefining the container name.
 */
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = args[i + 1];
  return next === undefined || next.startsWith('--') ? def : next;
};

const OUT = opt('out', 'tests/load/reports/monitor.json');
const INTERVAL = Number(opt('interval', 2000));
const METRICS_URL = opt('metrics', 'http://127.0.0.1:3001/api/v1/metrics');
const PG_CONTAINER = opt('pg', 'ziyarati-perfaudit-postgres');
const PG_DB = opt('db', 'ziyarati_perf');
const REDIS_CONTAINER = opt('redis', 'ziyarati-perfaudit-redis');
/**
 * Massive-scale additions. All three are OFF unless asked for, because each
 * costs a `docker exec` per sample and the existing callers are tuned around
 * the two the original monitor already paid for.
 *
 *   --redis     Redis PING latency, memory, connected clients, and BullMQ queue
 *               depth. Queue depth is the one signal that says whether the API
 *               is quietly building an unbounded backlog for a worker that is
 *               not running — invisible in both k6 and pg_stat_activity.
 *   --gen       Generator-side CPU/memory for the k6 container. Without this,
 *               "the system saturated" and "the load generator saturated" look
 *               identical from k6's own numbers, and the whole run is
 *               uninterpretable. Resolved by image ancestor because
 *               `docker compose run` names the container unpredictably.
 *   --locks     pg lock waits, deadlock count and top wait events.
 */
const WANT_REDIS = args.includes('--redis');
const WANT_GEN = args.includes('--gen');
const WANT_LOCKS = args.includes('--locks');

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

/**
 * Redis health + BullMQ backlog.
 *
 * Deliberately THREE small commands rather than one long `sh -c`. The first
 * attempt built a single script with nested `$( )` and mixed quote levels; it
 * ran correctly when pasted by hand yet returned `redis_unreachable` for every
 * sample of a 13-minute run, so the entire Redis dimension of that run was
 * lost. Simple beats clever for a probe you cannot re-run.
 *
 * A BullMQ queue is `<prefix>:<queue>:wait` (list), `:active` (list) and
 * `:delayed` (zset). `QUEUE_ENV_PREFIX` changes the prefix under the load-test
 * config, so the patterns below are deliberately prefix-agnostic.
 */
function redisInfo() {
  return new Promise((resolve) => {
    execFile('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'info'], { timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve({ error: 'redis_info_failed' });
        const grab = (re) => { const m = re.exec(String(stdout)); return m ? Number(m[1]) : null; };
        return resolve({
          used_memory_bytes: grab(/used_memory:(\d+)/),
          connected_clients: grab(/connected_clients:(\d+)/),
          ops_per_sec: grab(/instantaneous_ops_per_sec:(\d+)/),
          blocked_clients: grab(/blocked_clients:(\d+)/),
        });
      });
  });
}

function redisQueues() {
  // `--scan` returns KEY NAMES only, so cost is bounded by the number of
  // queues (single digits here), never by how deep the backlog is.
  const script = [
    'W=0; A=0; D=0;',
    'for k in $(redis-cli --scan --pattern "*:wait"); do W=$((W+$(redis-cli llen "$k"))); done;',
    'for k in $(redis-cli --scan --pattern "*:active"); do A=$((A+$(redis-cli llen "$k"))); done;',
    'for k in $(redis-cli --scan --pattern "*:delayed"); do D=$((D+$(redis-cli zcard "$k"))); done;',
    'echo "$W $A $D"',
  ].join(' ');
  return new Promise((resolve) => {
    execFile('docker', ['exec', REDIS_CONTAINER, 'sh', '-c', script], { timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve({ queue_error: String(err.message || '').slice(0, 80) });
        const parts = String(stdout).trim().split(/\s+/).map(Number);
        return resolve({ queue_wait: parts[0], queue_active: parts[1], queue_delayed: parts[2] });
      });
  });
}

function redisPing() {
  const startedAt = process.hrtime.bigint();
  return new Promise((resolve) => {
    execFile('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'ping'], { timeout: 8000 },
      (err) => {
        // Wall time INCLUDING `docker exec` startup, so this is a TREND across
        // the samples of one run, never an absolute Redis latency figure.
        return resolve({
          ping_roundtrip_seconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
          ping_ok: !err,
        });
      });
  });
}

async function redis() {
  if (!WANT_REDIS) return null;
  const [info, queues, ping] = await Promise.all([redisInfo(), redisQueues(), redisPing()]);
  return Object.assign({}, info, queues, ping);
}

/** Load-generator resource usage — proves generator vs application saturation. */
function generator() {
  if (!WANT_GEN) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('docker',
      ['ps', '-q', '--filter', 'ancestor=grafana/k6:latest'],
      { timeout: 5000 },
      (err, ids) => {
        const list = String(ids || '').trim().split('\n').filter(Boolean);
        if (err || !list.length) return resolve({ error: 'no_k6_container' });
        execFile('docker',
          ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.PIDs}}', ...list],
          { timeout: 10000 },
          (e2, out) => {
            if (e2) return resolve({ error: 'stats_failed' });
            const rows = String(out).trim().split('\n').filter(Boolean).map((r) => {
              const [cpu, mem, net, pids] = r.split('|');
              return {
                cpu_percent: Number(String(cpu).replace('%', '')),
                mem: String(mem).trim(),
                net: String(net).trim(),
                pids: Number(pids),
              };
            });
            resolve({
              containers: rows.length,
              // Docker reports CPU% against ALL cores, so 1600% is 16 saturated
              // cores on this 16-vCPU engine — the generator's own ceiling.
              cpu_percent_total: rows.reduce((a, r) => a + (r.cpu_percent || 0), 0),
              rows,
            });
          });
      });
  });
}

/** Lock waits, deadlocks and the dominant wait events. */
function locks() {
  if (!WANT_LOCKS) return Promise.resolve(null);
  const sql = `SELECT
      (SELECT deadlocks FROM pg_stat_database WHERE datname='${PG_DB}') AS deadlocks,
      (SELECT count(*) FROM pg_locks WHERE NOT granted) AS ungranted_locks,
      (SELECT COALESCE(string_agg(w, ','), '') FROM (
         -- GROUP BY on the ordinal would group by an expression that itself
         -- contains count(*), which Postgres rejects outright ("aggregate
         -- functions are not allowed in GROUP BY") and the whole probe then
         -- returns nothing at all. Group by the raw columns instead.
         SELECT wait_event_type || ':' || COALESCE(wait_event,'?') || '=' || count(*) AS w
         FROM pg_stat_activity
         WHERE datname='${PG_DB}' AND wait_event_type IS NOT NULL
         GROUP BY wait_event_type, wait_event
         ORDER BY count(*) DESC LIMIT 5) x) AS wait_events;`;
  return new Promise((resolve) => {
    execFile('docker',
      ['exec', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', PG_DB, '-t', '-A', '-F', '|', '-c', sql],
      { timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve({ error: 'pg_unreachable' });
        const p = String(stdout).trim().split('|');
        resolve({
          deadlocks: Number(p[0]),
          ungranted_locks: Number(p[1]),
          wait_events: p.slice(2).join('|'),
        });
      });
  });
}

const samples = [];
let stopping = false;

/**
 * Cross-platform stop signal.
 *
 * `kill -TERM` from Git Bash does NOT reach a Windows node process as a
 * catchable SIGTERM — the process is terminated outright, so the SIGTERM
 * handler never runs and the whole run's samples are lost with it (this cost
 * one contention run's server-side data). Polling for a sentinel file works
 * identically on every platform, so the orchestrator uses it instead.
 */
const STOPFILE = opt('stopfile', null);

async function tick() {
  if (stopping) return;
  if (STOPFILE && fs.existsSync(STOPFILE)) return finish();
  const [m, p, r, g, l] = await Promise.all([scrape(), pg(), redis(), generator(), locks()]);
  const s = { t: new Date().toISOString(), metrics: m, pg: p };
  if (r) s.redis = r;
  if (g) s.generator = g;
  if (l) s.locks = l;
  samples.push(s);
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

  // ── Massive-scale additions ────────────────────────────────────────────────
  const genCpu = num(samples.map((s) => (s.generator ? s.generator.cpu_percent_total : NaN)));
  const redisPing = num(samples.map((s) => (s.redis ? s.redis.ping_seconds : NaN)));
  const qWait = num(samples.map((s) => (s.redis ? s.redis.queue_wait : NaN)));
  const redisMem = num(samples.map((s) => (s.redis ? s.redis.used_memory_bytes : NaN)));
  const deadlocks = num(samples.map((s) => (s.locks ? s.locks.deadlocks : NaN)));
  const ungranted = num(samples.map((s) => (s.locks ? s.locks.ungranted_locks : NaN)));

  if (genCpu.length) {
    report.summary.generator_cpu_percent_max = max(genCpu);
    report.summary.generator_cpu_percent_last = last(genCpu);
    // The engine's total core budget, so "is the generator pegged" is a
    // comparison the reader does not have to make by hand.
    report.summary.generator_cpu_percent_ceiling = 100 * (Number(opt('cores', 16)));
  }
  if (redisPing.length) {
    report.summary.redis_ping_seconds_max = max(redisPing);
    report.summary.redis_used_memory_growth_bytes =
      (first(redisMem) != null && last(redisMem) != null) ? last(redisMem) - first(redisMem) : null;
  }
  if (qWait.length) {
    report.summary.queue_wait_first = first(qWait);
    report.summary.queue_wait_last = last(qWait);
    report.summary.queue_wait_max = max(qWait);
  }
  if (deadlocks.length) {
    // A COUNTER, so only the delta over the window is this run's contribution.
    report.summary.deadlocks_delta = last(deadlocks) - first(deadlocks);
    report.summary.ungranted_locks_max = max(ungranted);
  }

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
  if (s.generator_cpu_percent_max != null) {
    console.log(`  GENERATOR cpu max      : ${s.generator_cpu_percent_max}% `
      + `of ${s.generator_cpu_percent_ceiling}% (all cores)`);
  }
  if (s.redis_ping_seconds_max != null) {
    console.log(`  redis ping max         : ${s.redis_ping_seconds_max}s`);
    console.log(`  redis mem growth       : ${Math.round((s.redis_used_memory_growth_bytes || 0) / 1048576)} MB`);
  }
  if (s.queue_wait_max != null) {
    console.log(`  queue wait  first/last/max : ${s.queue_wait_first}/${s.queue_wait_last}/${s.queue_wait_max}`);
  }
  if (s.deadlocks_delta != null) {
    console.log(`  deadlocks (delta)      : ${s.deadlocks_delta}`);
    console.log(`  ungranted locks max    : ${s.ungranted_locks_max}`);
  }
  process.exit(0);
}

process.on('SIGINT', finish);
process.on('SIGTERM', finish);
const durationMs = Number(opt('duration', 0));
if (durationMs > 0) setTimeout(finish, durationMs);

tick();
