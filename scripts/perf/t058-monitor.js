'use strict';

/**
 * T058 — polls pg_stat_activity and the campaigns.processRecipient queue
 * depth every 500ms while a real worker (or workers) drains a seeded
 * backlog, until the queue empties or a timeout is hit. Prints a summary:
 * drain duration, throughput, and peak/mean active Postgres connections
 * attributable to the worker's own DB user (not other concurrent traffic).
 *
 * Usage: node scripts/perf/t058-monitor.js --run=<runId> --label=unsplit
 */
const { Client } = require('pg');
const { Queue } = require('bullmq');

const PG_CONN = process.env.PERF_PG_CONN || 'postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf';
const REDIS_HOST = process.env.PERF_REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.PERF_REDIS_PORT || 6380);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const label = args.label || 'run';
const timeoutMs = Number(args.timeout || 120000);

async function main() {
  const pg = new Client({ connectionString: PG_CONN });
  await pg.connect();
  const queue = new Queue('campaigns.processRecipient', {
    connection: { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 20 },
  });

  const samples = [];
  const start = Date.now();
  let lastCompleted = 0;
  let firstNonZero = null;

  while (Date.now() - start < timeoutMs) {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    const activeRes = await pg.query(
      `SELECT count(*) FILTER (WHERE state = 'active') AS active,
              count(*) FILTER (WHERE state = 'idle') AS idle,
              count(*) AS total
       FROM pg_stat_activity WHERE datname = current_database()`,
    );
    const pool = activeRes.rows[0];
    const t = Date.now() - start;
    samples.push({ t, ...counts, pgActive: Number(pool.active), pgIdle: Number(pool.idle), pgTotal: Number(pool.total) });
    if ((counts.completed + counts.failed) > 0 && firstNonZero === null) firstNonZero = t;
    const remaining = counts.waiting + counts.active + counts.delayed;
    if (remaining === 0 && counts.completed + counts.failed > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const last = samples[samples.length - 1];
  const durationS = last.t / 1000;
  const totalDone = last.completed + last.failed;
  const peakPgActive = Math.max(...samples.map((s) => s.pgActive));
  const meanPgActive = samples.reduce((s, x) => s + x.pgActive, 0) / samples.length;
  const peakPgTotal = Math.max(...samples.map((s) => s.pgTotal));
  const peakQueueActive = Math.max(...samples.map((s) => s.active));
  const peakQueueWaiting = Math.max(...samples.map((s) => s.waiting));

  const summary = {
    label,
    samples: samples.length,
    durationSeconds: Number(durationS.toFixed(2)),
    totalDone,
    throughputPerSec: Number((totalDone / durationS).toFixed(2)),
    peakPgActiveConnections: peakPgActive,
    meanPgActiveConnections: Number(meanPgActive.toFixed(2)),
    peakPgTotalConnections: peakPgTotal,
    peakQueueActiveJobs: peakQueueActive,
    peakQueueWaitingJobs: peakQueueWaiting,
    finalCounts: { completed: last.completed, failed: last.failed, waiting: last.waiting, active: last.active },
  };
  console.log(JSON.stringify(summary, null, 2));

  await queue.close();
  await pg.end();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
