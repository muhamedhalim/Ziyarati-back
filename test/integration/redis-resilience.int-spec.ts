/**
 * Docker/Testcontainers real-infra test (gap-closure pass — see
 * docs/CACHING_QUEUES_AUDIT.md §0.8.2). Proves three Phase 0 claims against a
 * REAL, disposable `redis:7-alpine` container (not a mock, not the shared dev
 * Redis) using the actual connection-option builders from `redis.config.ts`:
 *
 *  1. A delayed BullMQ job survives a container RESTART when AOF is enabled
 *     (mirrors `docker-compose.yml`'s `--appendonly yes --appendfsync everysec`).
 *  2. The `application`/`cache`/`rateLimiter` profiles fail FAST (bounded by
 *     `commandTimeout`) during a Redis blackhole — simulated with Redis's own
 *     `CLIENT PAUSE ALL` (stops command processing without dropping the TCP
 *     connection, a more targeted blackhole than a container-level pause) —
 *     not the ~60-80s unbounded default the pre-Phase-0 producer connection had.
 *  3. BullMQ's blocking Worker connection carries NO `commandTimeout` by
 *     construction, and survives the SAME blackhole without crashing or losing
 *     its ability to consume once Redis recovers.
 *
 * Run: npx jest --config test/jest-integration.json test/integration/redis-resilience.int-spec.ts
 *
 * SKIPS CLEANLY (mirrors `queue.int-spec.ts`) if Docker is unreachable —
 * availability is only known after `beforeAll` attempts to start the
 * container, so each test gates on it at run time rather than failing the
 * whole file at collection time.
 */
import 'dotenv/config';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

import {
  blockingConnectionOptions,
  producerConnectionOptions,
  applicationConnectionOptions,
} from '../../src/queue/redis.config';

let container: StartedTestContainer | undefined;
let available = false;
let redisUrl = '';

beforeAll(async () => {
  try {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withCommand(['redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec', '--maxmemory-policy', 'noeviction'])
      .start();
    redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    available = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Redis resilience test skipped (Docker/Testcontainers unavailable): ${(err as Error)?.message}`);
  }
}, 120_000);

afterAll(async () => {
  await container?.stop().catch(() => undefined);
});

/** Gate at RUN time (availability is only known after beforeAll) — mirrors queue.int-spec.ts. */
const runIf = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(
    name,
    async () => {
      if (!available) return;
      await fn();
    },
    timeout,
  );

function fakeConfig(): ConfigService {
  return { get: (k: string) => (k === 'REDIS_URL' ? redisUrl : undefined) } as unknown as ConfigService;
}

/** Redis's own CLIENT PAUSE — stops command processing for `ms` without dropping the TCP connection, a more precise blackhole than pausing the whole container. */
async function pauseRedisCommands(ms: number): Promise<void> {
  const result = await container!.exec(['redis-cli', 'CLIENT', 'PAUSE', String(ms), 'ALL']);
  if (result.exitCode !== 0) throw new Error(`redis-cli CLIENT PAUSE failed: ${result.stderr}`);
}

describe('Redis resilience (Testcontainers, real redis:7-alpine — gap-closure pass §0.8.2)', () => {
  runIf(
    'a delayed BullMQ job survives a container RESTART with AOF enabled',
    async () => {
      const cfg = fakeConfig();
      const queue = new Queue('resilience-persist-test', { connection: blockingConnectionOptions(cfg) });
      await queue.add('delayed-job', { hello: 'world' }, { delay: 30_000, jobId: 'persist-me' });

      const before = await queue.getJob('persist-me');
      expect(before).toBeTruthy();
      expect(await before!.isDelayed()).toBe(true);
      await queue.close();

      await container!.restart();

      // Fresh client after restart — proves the DATA survived, not just the process handle.
      const queueAfter = new Queue('resilience-persist-test', { connection: blockingConnectionOptions(cfg) });
      const after = await queueAfter.getJob('persist-me');
      expect(after).toBeTruthy();
      expect(after!.data).toEqual({ hello: 'world' });
      expect(await after!.isDelayed()).toBe(true);
      await queueAfter.obliterate({ force: true }).catch(() => undefined);
      await queueAfter.close();
    },
    90_000,
  );

  runIf(
    'the application/cache/rateLimiter profile fails FAST (bounded by commandTimeout) during a blackhole, not the ~60-80s unbounded default',
    async () => {
      const cfg = fakeConfig();
      const client = new Redis({ ...applicationConnectionOptions(cfg), lazyConnect: true });
      await client.connect();

      const pauseMs = 5000;
      const pausePromise = pauseRedisCommands(pauseMs);

      const started = Date.now();
      let threw = false;
      try {
        await client.ping();
      } catch {
        threw = true;
      }
      const elapsedMs = Date.now() - started;

      await pausePromise; // let the pause window elapse so the next test starts clean
      expect(threw).toBe(true);
      // commandTimeout is 2000ms — bounded by that plus generous scheduling
      // margin, nowhere near the pause window (5000ms) or the unbounded
      // pre-Phase-0 default (~60-80s).
      expect(elapsedMs).toBeLessThan(4000);

      await client.quit().catch(() => undefined);
    },
    30_000,
  );

  runIf(
    'the BullMQ blocking profile carries NO commandTimeout (static fact) and a live Worker survives the SAME blackhole without crashing',
    async () => {
      const cfg = fakeConfig();
      const blockingOpts = blockingConnectionOptions(cfg);
      expect(blockingOpts.commandTimeout).toBeUndefined();

      const worker = new Worker('resilience-worker-test', async () => 'processed', {
        connection: blockingConnectionOptions(cfg),
      });
      const workerErrors: Error[] = [];
      worker.on('error', (err) => workerErrors.push(err));
      await worker.waitUntilReady();

      // Same blackhole technique as the application-profile test above — a
      // commandTimeout-bearing client would have thrown well before this
      // elapses; the blocking Worker must not.
      await pauseRedisCommands(3000);
      await new Promise((resolve) => setTimeout(resolve, 3500));

      // Still alive: a job enqueued now is picked up by the SAME worker instance.
      const producerQueue = new Queue('resilience-worker-test', { connection: producerConnectionOptions(cfg) });
      const completed = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker did not complete the post-blackhole job in time')), 10_000);
        worker.once('completed', (job) => {
          clearTimeout(timer);
          resolve(job.id as string);
        });
        void producerQueue.add('after-blackhole', {}, { jobId: 'after-blackhole-1' });
      });

      expect(completed).toBe('after-blackhole-1');
      expect(workerErrors).toHaveLength(0);

      await producerQueue.obliterate({ force: true }).catch(() => undefined);
      await producerQueue.close();
      await worker.close();
    },
    30_000,
  );
});
