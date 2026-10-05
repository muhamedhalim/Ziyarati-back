#!/usr/bin/env node
/**
 * Campaign monitor — samples the SERVER side of a run into an NDJSON time series, so
 * every k6 latency number can be tied to a resource state.
 *
 *   node tests/load/lab/monitor-campaign.mjs --tag TAG [--interval 5] [--no-docker]
 *   (stops when run/monitor.<tag>.stop appears — a stop file, because Windows cannot
 *    deliver SIGTERM handlers; run-campaign.mjs creates it)
 *
 * Output: reports/<tag>.monitor.ndjson (one JSON object per sample) and, on stop,
 *         reports/<tag>.monitor.summary.json (min/max/last of each series).
 *
 * Collected (this supersedes helpers/monitor.js for the campaign: that one hard-codes the
 * old lab's container names and predates the P1.3 pool gauges and the worker):
 *   api     /api/v1/metrics  — event-loop lag, CPU seconds, RSS, heap, db_pool_{total,idle,waiting},
 *                              sum(db_queries_total), HTTP status-class counts
 *                              (UNDER API_CLUSTER_WORKERS>1 a scrape reaches ONE worker process:
 *                               the series is per-process and the sample says which pid answered)
 *   worker  :WORKER_METRICS_PORT/metrics — bullmq_queue_depth by queue/state, jobs by result,
 *                              heartbeat age
 *   pg      pg_stat_activity by state / wait-event type, ungranted locks, idle-in-transaction,
 *                              commits/rollbacks/DEADLOCKS, temp files, cache hit ratio inputs,
 *                              outbox_jobs by status
 *   redis   INFO: memory, clients, blocked clients, ops/s, evicted keys
 *   docker  `docker stats` of the lab containers and every lt-k6-* generator (CPU %, memory)
 * NOT collected here (and therefore NOT MEASURED unless added): Postgres slow-query log
 * correlation, per-route latency from the server (the HTTP duration histogram has no route
 * label), network throughput.
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
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const tag = opt('tag', 'adhoc');
const intervalMs = Number(opt('interval', 5)) * 1000;
const useDocker = !argv.includes('--no-docker');
const lab = loadLab();
const stopFile = path.join(RUN_DIR, `monitor.${tag}.stop`);
try { fs.rmSync(stopFile); } catch { /* none */ }

const { Client } = require('pg');
const Redis = require('ioredis');
const env = Object.fromEntries(fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));

const pg = new Client({ connectionString: env.DATABASE_URL, application_name: 'lt-monitor' });
await pg.connect();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
await redis.connect().catch(() => {});

function parseProm(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+-]+|NaN|\+Inf)$/.exec(line);
    if (!m) continue;
    (out[m[1]] = out[m[1]] || []).push({ l: m[2] || '', v: Number(m[3]) });
  }
  return out;
}
const sumOf = (p, n) => (p[n] || []).reduce((a, x) => a + x.v, 0);
const firstOf = (p, n) => (p[n] && p[n][0] ? p[n][0].v : null);
const labelVal = (l, k) => { const m = new RegExp(`${k}="([^"]*)"`).exec(l); return m ? m[1] : ''; };

async function scrape(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); if (r.status !== 200) return null; return parseProm(await r.text()); } catch { return null; }
}

async function sampleApi() {
  const p = await scrape(`http://127.0.0.1:${lab.ports.api}/api/v1/metrics`);
  if (!p) return { up: false };
  const statuses = {};
  for (const x of p.http_request_duration_seconds_count || []) { const c = `${labelVal(x.l, 'status_code')[0] || '?'}xx`; statuses[c] = (statuses[c] || 0) + x.v; }
  return {
    up: true,
    pid: firstOf(p, 'process_pid') ?? undefined,
    loopLagP99: firstOf(p, 'nodejs_eventloop_lag_p99_seconds'), loopLag: firstOf(p, 'nodejs_eventloop_lag_seconds'),
    cpuSec: firstOf(p, 'process_cpu_seconds_total'), rssMB: p.process_resident_memory_bytes ? Math.round(firstOf(p, 'process_resident_memory_bytes') / 1048576) : null,
    heapMB: p.nodejs_heap_size_used_bytes ? Math.round(firstOf(p, 'nodejs_heap_size_used_bytes') / 1048576) : null,
    poolTotal: firstOf(p, 'db_pool_total'), poolIdle: firstOf(p, 'db_pool_idle'), poolWaiting: firstOf(p, 'db_pool_waiting'),
    dbQueries: sumOf(p, 'db_queries_total'), http: statuses,
    throttlerEvents: sumOf(p, 'throttler_storage_events_total'),
  };
}
async function sampleWorker() {
  const p = await scrape(`http://127.0.0.1:${lab.ports.workerMetrics}/metrics`);
  if (!p) return { up: false };
  const depth = {};
  for (const x of p.bullmq_queue_depth || []) depth[`${labelVal(x.l, 'queue')}:${labelVal(x.l, 'state')}`] = x.v;
  const jobs = {};
  for (const x of p.bullmq_jobs_total || []) { const k = `${labelVal(x.l, 'queue')}:${labelVal(x.l, 'result') || labelVal(x.l, 'status')}`; jobs[k] = (jobs[k] || 0) + x.v; }
  const hb = firstOf(p, 'worker_heartbeat_timestamp_seconds');
  return { up: true, depth, jobs, heartbeatAgeS: hb ? Math.round(Date.now() / 1000 - hb) : null,
    loopLagP99: firstOf(p, 'nodejs_eventloop_lag_p99_seconds'), rssMB: p.process_resident_memory_bytes ? Math.round(firstOf(p, 'process_resident_memory_bytes') / 1048576) : null };
}
async function q(sql, params) { try { return (await pg.query(sql, params)).rows; } catch (e) { return [{ error: e.message }]; } }
async function samplePg() {
  const db = lab.db.name;
  const [states, waits, locks, idleTx, stat, outbox] = await Promise.all([
    q(`select coalesce(state,'none') s, count(*)::int c from pg_stat_activity where datname=$1 group by 1`, [db]),
    q(`select wait_event_type w, count(*)::int c from pg_stat_activity where datname=$1 and state<>'idle' and wait_event_type is not null group by 1`, [db]),
    q(`select count(*)::int c from pg_locks where not granted`),
    q(`select count(*)::int c from pg_stat_activity where datname=$1 and state like 'idle in transaction%'`, [db]),
    q(`select xact_commit, xact_rollback, deadlocks, numbackends, temp_files, blks_read, blks_hit, conflicts from pg_stat_database where datname=$1`, [db]),
    q(`select status, count(*)::int c from outbox_jobs group by 1`),
  ]);
  const o = {}; for (const r of outbox) if (r.status) o[r.status] = r.c;
  const st = {}; for (const r of states) if (r.s) st[r.s] = r.c;
  const w = {}; for (const r of waits) if (r.w) w[r.w] = r.c;
  return { states: st, waitingOn: w, ungrantedLocks: locks[0] && locks[0].c, idleInTx: idleTx[0] && idleTx[0].c, db: stat[0], outbox: o };
}
async function sampleRedis() {
  try {
    const info = await redis.info();
    const g = (k) => { const m = new RegExp(`^${k}:(.*)$`, 'm').exec(info); return m ? Number(m[1]) : null; };
    return { usedMB: Math.round(g('used_memory') / 1048576), clients: g('connected_clients'), blocked: g('blocked_clients'),
      opsPerSec: g('instantaneous_ops_per_sec'), evicted: g('evicted_keys'), commands: g('total_commands_processed'), rejected: g('rejected_connections') };
  } catch (e) { return { up: false, error: String(e.message).slice(0, 80) }; }
}
function sampleDocker() {
  if (!useDocker) return undefined;
  const r = spawnSync('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return undefined;
  const rows = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (/ziyarati-c20k|lt-k6-/.test(j.Name)) rows.push({ name: j.Name, cpu: j.CPUPerc, mem: j.MemUsage }); } catch { /* skip */ }
  }
  return rows;
}

const outPath = path.join(REPORTS, `${tag}.monitor.ndjson`);
fs.mkdirSync(REPORTS, { recursive: true });
const fd = fs.openSync(outPath, 'a');
const agg = {};
const track = (prefix, obj) => {
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      const key = `${prefix}.${k}`; const a = agg[key] || (agg[key] = { min: v, max: v, last: v });
      a.min = Math.min(a.min, v); a.max = Math.max(a.max, v); a.last = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) track(`${prefix}.${k}`, v);
  }
};

console.log(`monitor: ${tag} every ${intervalMs / 1000}s -> ${path.relative(REPO, outPath)}`);
let n = 0;
while (!fs.existsSync(stopFile)) {
  const t0 = Date.now();
  const [api, worker, pgS, rds] = await Promise.all([sampleApi(), sampleWorker(), samplePg(), sampleRedis()]);
  const row = { t: new Date().toISOString(), api, worker, pg: pgS, redis: rds, docker: sampleDocker() };
  fs.writeSync(fd, JSON.stringify(row) + '\n');
  track('api', api); track('worker', worker); track('pg', pgS); track('redis', rds);
  n++;
  const wait = intervalMs - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
fs.closeSync(fd);
fs.writeFileSync(path.join(REPORTS, `${tag}.monitor.summary.json`), JSON.stringify({ tag, samples: n, intervalMs, series: agg }, null, 2));
try { fs.rmSync(stopFile); } catch { /* ignore */ }
await pg.end(); redis.disconnect();
console.log(`monitor: ${n} samples`);
