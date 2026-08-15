/**
 * T137 — Redis-unavailable degradation, per subsystem (FR-062, FR-076).
 *
 * Stops/starts the REAL disposable e2e Redis container (`zt-e2e-redis`, port
 * 63790 — `test/utils/docker-redis-control.ts`, already used by the 009-auth-
 * abuse-resistance suites) mid-test and records OBSERVED behavior for four
 * subsystems the AI surface depends on:
 *
 *  1. Rate limiting (`FailsafeThrottlerStorage`, the first global `APP_GUARD`,
 *     reachable even on `@Public()` AI routes).
 *  2. The embedding cache (`QueueService.kvGet/kvSet/kvMget`, the primitive
 *     `OpenAiEmbeddingProvider.cacheMget/cacheSet` build on).
 *  3. The realtime Socket.IO Redis adapter (`RedisIoAdapter`, `/ai` namespace
 *     horizontal-scaling).
 *  4. Queue admission (`QueueService.enqueueAiExecute`, the BullMQ producer
 *     connection `ai.execute` — itself a dead code path per `w1-async.md`,
 *     exercised here only as the concrete "queue admission" mechanism T137
 *     names, not as a claim that this specific job type is reachable in prod).
 *
 * Every degraded-mode test restores Redis and waits for readiness in its own
 * `afterEach`/`finally` — this container is shared with any sibling spec file
 * that happens to run concurrently, so exposure is kept as short as possible
 * (mirrors the existing precedent in `test/auth-abuse-redis-degradation.e2e-
 * spec.ts`). Run this file with `--runInBand` (or alone) to eliminate cross-
 * file interference entirely; see HARNESS_GUIDE.md.
 */
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { dockerStop, dockerStart, waitForRedisReady, safely, sleep } from '../utils/docker-redis-control';
import { AppRedisService } from '../../src/queue/app-redis.service';
import { MetricsService } from '../../src/metrics/metrics.service';
import { FailsafeThrottlerStorage } from '../../src/queue/failsafe-throttler-storage';
import { RedisIoAdapter } from '../../src/modules/ai-realtime/redis-io.adapter';
import { QueueService } from '../../src/queue/queue.service';

/** Bounded wait so a hang is OBSERVED (and reported), never silently blocking the test run forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<{ settled: 'resolved' | 'rejected' | 'timeout'; value?: T; error?: unknown }> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ settled: 'timeout' });
      }
    }, ms);
    p.then((value) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ settled: 'resolved', value });
      }
    }).catch((error) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ settled: 'rejected', error });
      }
    });
    void label;
  });
}

describe('AI-relevant subsystems under Redis-unavailable (T137)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  const observed: Record<string, unknown> = {};

  beforeAll(async () => {
    await waitForRedisReady();
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
  }, 120_000);

  afterAll(async () => {
    safely(() => dockerStart()); // absolute safety net regardless of what ran last
    await waitForRedisReady().catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();

    process.stdout.write('\n===W9-REDIS-DEGRADATION-SUMMARY===\n');
    process.stdout.write(JSON.stringify(observed, null, 2) + '\n');
  }, 60_000);

  // ─────────────────────────── 1) Rate limiting ──────────────────────────── //

  describe('Rate limiting — FailsafeThrottlerStorage (first global APP_GUARD, reaches @Public() AI routes too)', () => {
    afterEach(async () => {
      safely(() => dockerStart());
      await waitForRedisReady();
    });

    it('degrades to a LOCAL, still-enforcing counter on Redis failure — never a raw ioredis throw, and never unlimited', async () => {
      const appRedis = harness.app.get(AppRedisService);
      const metrics = harness.app.get(MetricsService);
      const storage = new FailsafeThrottlerStorage(
        new ThrottlerStorageRedisService(appRedis.application),
        metrics,
        64, // small fallback width so this test is fast and deterministic
      );

      // Healthy baseline — goes to Redis, works normally.
      const healthy = await storage.increment('t137-rl-key', 60_000, 3, 60_000, 'default');
      expect(healthy.isBlocked).toBe(false);

      dockerStop();
      await sleep(300); // let the existing connection actually notice the drop

      const key = `t137-rl-key-degraded-${Date.now()}`;
      const results: Array<{ isBlocked: boolean; totalHits: number }> = [];
      for (let i = 0; i < 5; i += 1) {
        // limit=3: the 4th and 5th calls must be blocked if enforcement continues.
        // eslint-disable-next-line no-await-in-loop
        const r = await storage.increment(key, 60_000, 3, 60_000, 'default');
        results.push({ isBlocked: r.isBlocked, totalHits: r.totalHits });
      }

      observed.rateLimiter = { healthyBlocked: healthy.isBlocked, degradedResults: results };

      // No raw ioredis error escaped (every call above resolved, not rejected).
      expect(results).toHaveLength(5);
      // Still enforcing in degraded mode: calls 4 and 5 (index 3, 4) are blocked.
      expect(results[3].isBlocked).toBe(true);
      expect(results[4].isBlocked).toBe(true);
      // Judgment: CORRECT degraded behavior — a Redis outage narrows enforcement
      // to per-process (so N replicas effectively allow limit×N during the
      // outage) rather than removing it. This is the documented, deliberate
      // design (see FailsafeThrottlerStorage's own docblock) and it is NOT the
      // ZT-002-style "fails fully open" pattern.
    }, 30_000);
  });

  // ─────────────────────────── 2) Embedding cache (KV primitive) ─────────── //

  describe('Embedding cache primitive — QueueService.kvGet/kvSet/kvMget (the "application" Redis profile)', () => {
    afterEach(async () => {
      safely(() => dockerStart());
      await waitForRedisReady();
    });

    it('the KV primitive itself FAILS FAST (rejects within ~2s, never hangs) when Redis is unreachable — confirms the "application" profile\'s commandTimeout:2000/maxRetriesPerRequest:1/enableOfflineQueue:false contract', async () => {
      const queue = harness.app.get(QueueService);
      // Healthy baseline. The APP's own `appRedis.application` ioredis client
      // (a distinct connection from the docker-level `redis-cli ping`
      // `waitForRedisReady()` uses) can still be mid-reconnect for a moment
      // after a sibling describe block's own stop/start cycle — retry briefly
      // rather than fail on a transient "stream isn't writeable" during that
      // window (this connection has enableOfflineQueue:false BY DESIGN, so it
      // does not buffer through a not-yet-reconnected gap).
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await queue.redisPing();
          break;
        } catch {
          await sleep(300);
        }
      }
      await queue.kvSet('t137-kv-healthy', 'ok', 30);
      expect(await queue.kvGet('t137-kv-healthy')).toBe('ok');

      dockerStop();
      await sleep(300);

      const started = Date.now();
      const outcome = await withTimeout(queue.kvMget(['t137-kv-healthy', 'anything-else']), 8_000, 'kvMget');
      const elapsedMs = Date.now() - started;

      observed.embeddingCachePrimitive = { outcome: outcome.settled, elapsedMs };

      expect(outcome.settled).toBe('rejected'); // fails fast, not silently returns nulls, not a hang
      expect(elapsedMs).toBeLessThan(6_000); // well under the 8s race — the ~2s command timeout, not a full retry storm

      // The CALLER'S responsibility: `OpenAiEmbeddingProvider.cacheMget`/
      // `cacheSet` (`src/modules/ai/providers/openai-embedding.provider.ts:286-
      // 328`) wrap exactly this call in try/catch and return a MISS/no-op on
      // failure (statically confirmed by direct code read in this task — NOT
      // independently re-executed here, because doing so would require the
      // real embedding provider to then fall through to a live OpenAI network
      // call, which this harness's design deliberately forbids, FR-103). This
      // is recorded as a code-confirmed, not runtime-confirmed, sub-finding —
      // see the T141 signalling doc for the explicit scope note.
    }, 20_000);
  });

  // ─────────────────────────── 3) Realtime Socket.IO Redis adapter ───────── //

  describe('Realtime gateway horizontal-scaling adapter — RedisIoAdapter.connectToRedis()', () => {
    afterEach(async () => {
      safely(() => dockerStart());
      await waitForRedisReady();
    });

    it('falls back to the in-memory adapter (no adapterConstructor set, no throw) when Redis is unreachable at connect time', async () => {
      dockerStop();
      await sleep(300);

      const adapter = new RedisIoAdapter(harness.app) as unknown as {
        connectToRedis: () => Promise<void>;
        adapterConstructor?: unknown;
      };
      await expect(adapter.connectToRedis()).resolves.toBeUndefined();
      observed.realtimeAdapter = { adapterConstructorSetAfterFailedConnect: !!adapter.adapterConstructor };
      expect(adapter.adapterConstructor).toBeUndefined();
      // Judgment: CORRECT degraded behavior for a SINGLE-instance deployment
      // (the default here, API_CLUSTER_WORKERS<=1) — cross-worker event
      // broadcast is simply unavailable, but the gateway itself keeps working
      // for directly-connected sockets via Socket.IO's own in-memory adapter.
      // A genuinely multi-instance deployment losing this adapter mid-flight
      // would silently stop delivering events to sockets on OTHER instances
      // with no error surfaced anywhere — a horizontal-scaling correctness gap
      // worth naming explicitly, not a crash risk.
    }, 15_000);
  });

  // ─────────────────────────── 4) Queue admission (BullMQ producer) ──────── //

  describe('Queue admission — QueueService.enqueueAiExecute (BullMQ PRODUCER connection, enableOfflineQueue:true)', () => {
    afterEach(async () => {
      safely(() => dockerStart());
      await waitForRedisReady();
    });

    it('does NOT fail fast and does NOT silently drop the job: the producer connection BUFFERS the enqueue call, which hangs from the caller\'s perspective until Redis returns', async () => {
      const queue = harness.app.get(QueueService);
      dockerStop();
      await sleep(300);

      const jobData = {
        tenantId: seed.tenantA.id,
        aiConversationId: 'w9-redis-degradation-probe',
        content: 'synthetic probe content — never processed',
        idempotencyKey: `t137-queue-admission-${Date.now()}`,
      };

      const started = Date.now();
      const attempt = queue.enqueueAiExecute(jobData as never);
      const race = await withTimeout(attempt, 5_000, 'enqueueAiExecute');
      const hungForMs = Date.now() - started;

      // Now restore Redis and see whether the SAME buffered call eventually
      // resolves once connectivity returns (proving it was BUFFERED, not lost)
      // — only meaningful if it was still pending at the 5s mark.
      let resolvedAfterRecovery: { settled: string; totalWaitMs: number } | null = null;
      if (race.settled === 'timeout') {
        dockerStart();
        const recoveryStart = Date.now();
        const after = await withTimeout(attempt, 15_000, 'enqueueAiExecute-post-recovery');
        resolvedAfterRecovery = { settled: after.settled, totalWaitMs: Date.now() - recoveryStart };
      }

      observed.queueAdmission = {
        initialRaceOutcome: race.settled,
        hungForMs,
        resolvedAfterRecovery,
      };

      // The finding: admission neither fails fast (fail-closed, clear error to
      // the caller so it can degrade/retry deliberately) nor fails open
      // (silently accepted and dropped) — it HANGS the calling request/turn
      // until Redis recovers, bounded only by ioredis's own retryStrategy
      // (capped backoff, retries indefinitely). For any code path that awaits
      // enqueueAiExecute() synchronously (none currently reachable in
      // production, per w1-async.md — but the mechanism itself is what this
      // task asks to characterize), a Redis outage would hang that request
      // rather than returning a clean error or degrading. This is worth a
      // candidate finding even though the specific `ai.execute` job is dead
      // code today, because `producerConnectionOptions()`'s `enableOfflineQueue:
      // true` is the SHARED profile every BullMQ producer enqueue in this
      // codebase uses, AI or not.
      expect(race.settled).toBe('timeout');
      if (resolvedAfterRecovery) {
        expect(resolvedAfterRecovery.settled).toBe('resolved');
      }
    }, 30_000);
  });
});
