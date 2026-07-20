/**
 * OFFLINE integration test — real Redis + BullMQ. Proves queue reliability
 * primitives the AI batch poll worker relies on: enqueue→consume round-trip,
 * retry with backoff, idempotent enqueue by jobId, and worker-restart recovery.
 * NO OpenAI. Skips cleanly if Redis is unreachable.
 *
 * Run: npx jest --config test/jest-integration.json
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { Queue, Worker, Job } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
let available = false;

beforeAll(async () => {
  const probe = new IORedis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  try {
    await probe.connect();
    await probe.ping();
    available = true;
  } catch {
    console.warn('Queue integration test skipped (no Redis)');
  } finally {
    probe.disconnect();
  }
});

// Gate at RUN time (availability is only known after beforeAll).
const runIf = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  });
const gate = () => runIf;
// Pass plain connection OPTIONS (not an ioredis instance) so BullMQ builds its
// own client — avoids a type clash between the top-level ioredis and the copy
// nested under bullmq. maxRetriesPerRequest: null is required for blocking workers.
const conn = () => {
  const u = new URL(REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    maxRetriesPerRequest: null as null,
  };
};
const waitFor = (fn: () => boolean, ms = 5000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fn()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error('timeout'));
      }
    }, 25);
  });

describe('BullMQ + Redis — real integration (no OpenAI)', () => {
  gate()(
    'round-trips a job from producer to worker with its payload',
    async () => {
      const name = `int-q-${randomUUID().slice(0, 8)}`;
      const q = new Queue(name, { connection: conn() });
      const seen: unknown[] = [];
      const w = new Worker(
        name,
        async (job: Job) => {
          seen.push(job.data);
          return 'ok';
        },
        { connection: conn() },
      );
      try {
        await q.add('do', { tenantId: 't1', n: 42 });
        await waitFor(() => seen.length === 1);
        expect(seen[0]).toEqual({ tenantId: 't1', n: 42 });
      } finally {
        await w.close();
        await q.obliterate({ force: true });
        await q.close();
      }
    },
  );

  gate()(
    'retries a failing job with backoff, then succeeds (idempotency-safe processing)',
    async () => {
      const name = `int-retry-${randomUUID().slice(0, 8)}`;
      const q = new Queue(name, { connection: conn() });
      let attempts = 0;
      let completed = false;
      const w = new Worker(
        name,
        async () => {
          attempts += 1;
          if (attempts < 2) throw new Error('transient');
          completed = true;
        },
        { connection: conn() },
      );
      try {
        await q.add(
          'do',
          { x: 1 },
          { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
        );
        await waitFor(() => completed, 8000);
        expect(attempts).toBe(2); // failed once, succeeded on retry
      } finally {
        await w.close();
        await q.obliterate({ force: true });
        await q.close();
      }
    },
  );

  gate()('deduplicates enqueue by jobId (idempotent producer)', async () => {
    const name = `int-dedupe-${randomUUID().slice(0, 8)}`;
    const q = new Queue(name, { connection: conn() });
    try {
      await q.add('do', { a: 1 }, { jobId: 'fixed-id' });
      await q.add('do', { a: 2 }, { jobId: 'fixed-id' }); // same id → no second job
      const counts = await q.getJobCounts(
        'waiting',
        'delayed',
        'active',
        'completed',
      );
      const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
      expect(total).toBe(1);
    } finally {
      await q.obliterate({ force: true });
      await q.close();
    }
  });

  gate()(
    'recovers a job enqueued while no worker was running (restart recovery)',
    async () => {
      const name = `int-restart-${randomUUID().slice(0, 8)}`;
      const q = new Queue(name, { connection: conn() });
      // Enqueue with NO worker running (simulates worker down).
      await q.add('do', { restart: true });
      // "Restart": bring a worker up now; it must pick up the persisted job.
      let processed = false;
      const w = new Worker(
        name,
        async () => {
          processed = true;
        },
        { connection: conn() },
      );
      try {
        await waitFor(() => processed, 6000);
        expect(processed).toBe(true);
      } finally {
        await w.close();
        await q.obliterate({ force: true });
        await q.close();
      }
    },
  );
});
