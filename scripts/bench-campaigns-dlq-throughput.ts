/**
 * PR-008 (Wave 4, T130/FND-038 remainder) — before/after CAMPAIGNS_LAUNCH and
 * CAMPAIGNS_FANOUT throughput, against REAL Redis + BullMQ (no mocks — a
 * mocked queue proves nothing about actual scheduling/retry overhead).
 * Mirrors `bench-whatsapp-queue-throughput.ts` (T052, Wave 2)'s exact
 * methodology, extended to the two processors this wave's FND-038 fix
 * touched: `CampaignLaunchProcessor`/`CampaignFanoutProcessor`'s `onFailed`
 * previously only logged; it now also enqueues onto CAMPAIGNS_DLQ once a job
 * is exhausted/permanent. The SUCCESS path's shape is unchanged either way —
 * measured anyway rather than assumed.
 *
 * Run:  npx ts-node -r tsconfig-paths/register scripts/bench-campaigns-dlq-throughput.ts
 * Requires REDIS_URL (a real Redis — docker `ziyaratech-redis` in dev).
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';

import { blockingConnectionOptions, producerConnectionOptions } from '../src/queue/redis.config';

const config = new ConfigService(process.env as Record<string, unknown>);
const N_SUCCESS = 500;
const N_FAILURE = 50;

type Shape = 'old' | 'new';

interface BenchResult {
  shape: Shape;
  scenario: 'success' | 'failure';
  n: number;
  ms: number;
  jobsPerSec: number;
}

/** No-op stand-in for CampaignFanoutService.handleLaunch/handleChunk. */
async function fakeHandle(shouldFail: boolean): Promise<void> {
  await Promise.resolve();
  if (shouldFail) throw new Error('simulated launch/fanout failure');
}

async function runScenario(
  shape: Shape,
  scenario: 'success' | 'failure',
  n: number,
): Promise<BenchResult> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const queueName = `bench.campaigns-launch.${suffix}`;
  const dlqName = `bench.campaigns.dlq.${suffix}`;

  const producerConn = producerConnectionOptions(config);
  const queue = new Queue(queueName, { connection: producerConn });
  const dlq = new Queue(dlqName, { connection: producerConn });

  let settled = 0;
  let resolveDone: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  const worker = new Worker(
    queueName,
    async () => {
      await fakeHandle(scenario === 'failure');
    },
    { connection: blockingConnectionOptions(config), concurrency: 10 },
  );

  worker.on('completed', () => {
    settled += 1;
    if (settled === n) resolveDone();
  });
  worker.on('failed', async (job) => {
    if (shape === 'new' && job) {
      // Mirrors CampaignLaunchProcessor/CampaignFanoutProcessor's new
      // parkExhaustedOrPermanent() -> enqueueCampaignDlq() call (this wave's
      // FND-038 fix). The 'old' shape does the equivalent of the PRE-FIX
      // onFailed, which only logged.
      await dlq.add('campaigns.dlq', { originalJobId: job.id, failedReason: job.failedReason });
    }
    settled += 1;
    if (settled === n) resolveDone();
  });

  await queue.waitUntilReady();
  await worker.waitUntilReady();

  const start = process.hrtime.bigint();
  await queue.addBulk(
    Array.from({ length: n }, () => ({
      name: 'campaigns.launch',
      data: { tenantId: 't1', campaignId: 'c1', runId: 'r1', idempotencyKey: 'k1' },
      opts: { attempts: 1 },
    })),
  );
  await done;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;

  await worker.close();
  await queue.obliterate({ force: true });
  await dlq.obliterate({ force: true });
  await queue.close();
  await dlq.close();

  return { shape, scenario, n, ms, jobsPerSec: n / (ms / 1000) };
}

function fmt(r: BenchResult): string {
  return `${r.shape.padEnd(4)} ${r.scenario.padEnd(8)} n=${r.n.toString().padEnd(4)} ${r.ms.toFixed(0).padStart(6)}ms  ${r.jobsPerSec.toFixed(1).padStart(8)} jobs/sec`;
}

async function main() {
  console.log(`PR-008 CAMPAIGNS_LAUNCH/FANOUT throughput — before/after Wave 4's FND-038 fix (real Redis/BullMQ)\n`);

  const results: BenchResult[] = [];
  for (const scenario of ['success', 'failure'] as const) {
    const n = scenario === 'success' ? N_SUCCESS : N_FAILURE;
    for (const shape of ['old', 'new', 'old', 'new'] as Shape[]) {
      const r = await runScenario(shape, scenario, n);
      results.push(r);
      console.log(fmt(r));
    }
  }

  console.log('\n── Summary (mean of the two runs per shape) ──');
  for (const scenario of ['success', 'failure'] as const) {
    const old = results.filter((r) => r.scenario === scenario && r.shape === 'old');
    const neu = results.filter((r) => r.scenario === scenario && r.shape === 'new');
    const meanOld = old.reduce((s, r) => s + r.jobsPerSec, 0) / old.length;
    const meanNew = neu.reduce((s, r) => s + r.jobsPerSec, 0) / neu.length;
    const deltaPct = ((meanNew - meanOld) / meanOld) * 100;
    console.log(
      `${scenario.padEnd(8)} old=${meanOld.toFixed(1)} jobs/sec  new=${meanNew.toFixed(1)} jobs/sec  delta=${deltaPct.toFixed(1)}%`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('bench error:', e);
  process.exit(1);
});
