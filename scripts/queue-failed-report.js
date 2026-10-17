#!/usr/bin/env node
/**
 * READ-ONLY dump of failed BullMQ jobs (analytics / email / workflow by default).
 * Never retries, removes or mutates anything: it only calls Queue#getFailed.
 *
 *   REDIS_URL=rediss://... node scripts/queue-failed-report.js [queue ...]
 *
 * Payloads are redacted: only ids/keys of the data object are printed, plus
 * non-sensitive scalar fields (tenantId, runId, kind, date, month, ...).
 * Recipients, variables, tokens and free text are never emitted.
 */
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const SAFE_SCALARS = new Set([
  'tenantId', 'actorId', 'runId', 'actionIndex', 'kind', 'date', 'month',
  'branchId', 'invoiceId', 'documentVersion', 'exportJobId', 'correlationId',
  'template', 'templateKey', 'type',
]);

function redact(data) {
  if (!data || typeof data !== 'object') return typeof data;
  const out = { _keys: Object.keys(data) };
  for (const k of SAFE_SCALARS) if (k in data) out[k] = data[k];
  return out;
}

async function main() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  const queues = process.argv.slice(2);
  const names = queues.length ? queues : ['analytics', 'email', 'workflow'];
  const prefix = process.env.BULL_PREFIX || 'bull';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  for (const name of names) {
    const q = new Queue(name, { connection, prefix });
    const jobs = await q.getFailed(0, 200);
    console.log(`\n=== ${name}: ${jobs.length} failed ===`);
    for (const j of jobs) {
      console.log(JSON.stringify({
        queue: name,
        jobId: j.id,
        name: j.name,
        attemptsMade: j.attemptsMade,
        attemptsMax: j.opts && j.opts.attempts,
        timestamp: j.timestamp && new Date(j.timestamp).toISOString(),
        finishedOn: j.finishedOn && new Date(j.finishedOn).toISOString(),
        failedReason: j.failedReason,
        stacktrace: (j.stacktrace || []).map((s) => String(s).split('\n').slice(0, 6).join('\n')),
        data: redact(j.data),
      }, null, 2));
    }
    await q.close();
  }
  await connection.quit();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
