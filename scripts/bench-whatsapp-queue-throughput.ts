/**
 * PR-008 (T052) — before/after WhatsApp queue throughput, against REAL Redis
 * + BullMQ (no mocks — a mocked queue proves nothing about actual scheduling/
 * lock/retry overhead).
 *
 * FND-022 changed `whatsapp.processor.ts` in two ways: (1) a provider-FAILED
 * result is now THROWN instead of returned, so BullMQ actually retries it;
 * (2) once a job is exhausted/permanent, `onFailed` now does one extra async
 * enqueue onto the DLQ queue. Neither change touches the SUCCESS path's
 * shape, but this measures both paths for real rather than assuming.
 *
 * This does not call WhatsappExecutionService or any provider — it measures
 * OUR code's own overhead (BullMQ scheduling + the processor body), which is
 * what PR-008 is actually asking about. Provider/network latency is a
 * separate, orthogonal concern.
 *
 * Run:  npx ts-node -r tsconfig-paths/register scripts/bench-whatsapp-queue-throughput.ts
 * Requires REDIS_URL (a real Redis — docker `ziyaratech-redis` in dev).
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';

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

/** Mirrors WhatsappExecutionService.sendTemplateMessage's return shape, no I/O. */
async function fakeSend(shouldFail: boolean): Promise<{ status: string; error?: string }> {
  // Same-tick microtask hop (matches the real call being `await`ed) without
  // any real network/DB latency — isolates the PROCESSOR's own overhead.
  await Promise.resolve();
  return shouldFail
    ? { status: 'FAILED', error: 'simulated provider failure' }
    : { status: 'SENT' };
}

async function runScenario(
  shape: Shape,
  scenario: 'success' | 'failure',
  n: number,
): Promise<BenchResult> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const queueName = `bench.whatsapp-outbound.${suffix}`;
  const dlqName = `bench.whatsapp.dlq.${suffix}`;

  const producerConn = producerConnectionOptions(config);
  const queue = new Queue(queueName, { connection: producerConn });
  const dlq = new Queue(dlqName, { connection: producerConn });

  let settled = 0;
  let resolveDone: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const result = await fakeSend(scenario === 'failure');
      if (shape === 'old') {
        // Pre-FND-022 shape: FAILED is a normal return, no throw, no DLQ.
        return result;
      }
      // Post-FND-022 shape: FAILED is thrown so BullMQ actually retries it.
      if (result.status === 'FAILED') {
        throw new Error(result.error ?? 'WhatsApp provider send failed');
      }
      return result;
    },
    { connection: blockingConnectionOptions(config), concurrency: 10 },
  );

  worker.on('completed', () => {
    settled += 1;
    if (settled === n) resolveDone();
  });
  worker.on('failed', async (job) => {
    if (shape === 'new' && job) {
      // Mirrors WhatsappProcessor.onFailed's exhausted/permanent -> DLQ park.
      await dlq.add('whatsapp.dlq', { originalJobId: job.id, failedReason: job.failedReason });
    }
    settled += 1;
    if (settled === n) resolveDone();
  });

  await queue.waitUntilReady();
  await worker.waitUntilReady();

  const start = process.hrtime.bigint();
  await queue.addBulk(
    Array.from({ length: n }, (_, i) => ({
      name: 'whatsapp.send',
      data: { tenantId: 't1', templateId: 'tpl1', payload: {} },
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
  console.log(`PR-008 WhatsApp queue throughput — before/after FND-022 (real Redis/BullMQ)\n`);

  const results: BenchResult[] = [];
  // Interleaved (old, new, old, new) per scenario to average out any
  // ambient system-load skew instead of running all of one shape first.
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
