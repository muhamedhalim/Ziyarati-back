/**
 * T057 — per-queue job counts/duration via real BullMQ + Redis (MP-backend-05).
 * Read-only: getJobCounts + sampled recent job timestamps, never mutates queue state.
 */
import { Queue } from 'bullmq';
import { ALL_QUEUES } from '../../src/queue/queue.constants';

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL must be set');
  const url = new URL(redisUrl);

  const connection = { host: url.hostname, port: Number(url.port) };
  const rows: Array<Record<string, unknown>> = [];

  for (const name of ALL_QUEUES) {
    const q = new Queue(name, { connection });
    const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
    let avgDurationMs: number | null = null;
    if (counts.completed > 0) {
      const recent = await q.getJobs(['completed'], 0, 9, false);
      const durations = recent
        .filter((j) => j.finishedOn && j.processedOn)
        .map((j) => j.finishedOn! - j.processedOn!);
      if (durations.length) avgDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;
    }
    if (total > 0 || counts.failed > 0) {
      rows.push({ queue: name, ...counts, sampledAvgDurationMs: avgDurationMs });
    }
    await q.close();
  }

  console.table(rows);
  console.log(`\n${ALL_QUEUES.length} total queues checked; ${rows.length} have any recorded state.`);

  const fs = require('node:fs');
  fs.writeFileSync(
    require('node:path').join(__dirname, 'queue-metrics-results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), totalQueues: ALL_QUEUES.length, queuesWithState: rows }, null, 2),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
