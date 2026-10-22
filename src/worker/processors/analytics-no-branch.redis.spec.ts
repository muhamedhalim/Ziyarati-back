import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Logger } from '@nestjs/common';

import { AnalyticsProcessor } from './analytics.processor';
import { DailyReportService } from '../../modules/analytics/daily-report.service';
import { AnalyticsAggregationService } from '../../modules/analytics/analytics-aggregation.service';
import { AnalyticsCacheService } from '../../modules/analytics/analytics-cache.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { ProducerQueues } from '../../queue/producer-queues';
import { ALL_QUEUES, JOB, QUEUE, QueueName } from '../../queue/queue.constants';

/**
 * Root cause of the permanent "failed" count on /platform/monitoring, proven
 * against a real BullMQ Worker + Redis (the disposable e2e container on
 * :63790, or REDIS_TEST_URL). Production evidence (CloudWatch, worker
 * 2026-10-15 … 2026-10-22): every night at 00:30 UTC the job
 * `analytics-daily-<tenant>-<date>` for one tenant with no active branch ran
 * 5 attempts ("No active branches to generate a report for") and ended in
 * `failed`; 7-day failed retention kept ~7 of them on the page permanently.
 *
 * Runs the REAL AnalyticsProcessor and DailyReportService; only the DB-facing
 * aggregation service is stubbed. Isolated under a unique key prefix and
 * obliterated afterwards. Skipped — and reported as skipped — when no Redis
 * answers.
 */
const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:63790';

async function redisAvailable(): Promise<boolean> {
  const probe = new IORedis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

describe('analytics.generateReport for a tenant with no active branch (real BullMQ + Redis)', () => {
  let available = false;
  const prefix = `nobranch-${process.pid}-${Date.now()}`;
  const connection = { url: REDIS_URL, maxRetriesPerRequest: null };
  let queues: Record<QueueName, Queue> | undefined;
  let events: QueueEvents | undefined;
  let worker: Worker | undefined;
  let queueService: QueueService;
  const aggregation = {
    listActiveBranchIds: jest.fn(),
    assertBranch: jest.fn(),
  };
  const cache = { wrap: jest.fn(), invalidate: jest.fn().mockResolvedValue(undefined) };
  // Same attempt count as production defaultJobOptions; fixed tiny backoff to keep the test fast.
  const jobOpts = { attempts: 5, backoff: { type: 'fixed', delay: 10 } };

  beforeAll(async () => {
    available = await redisAvailable();
    if (!available) return;
    Logger.overrideLogger(['error']);
    queues = Object.fromEntries(
      ALL_QUEUES.map((name) => [name, new Queue(name, { connection, prefix })]),
    ) as Record<QueueName, Queue>;
    queueService = new QueueService(
      { record: () => queues } as unknown as ProducerQueues,
      new TenantContextService(),
      {} as never,
      {} as never,
    );
    events = new QueueEvents(QUEUE.ANALYTICS, { connection, prefix });
    await events.waitUntilReady();

    const daily = new DailyReportService(
      { createQueryBuilder: jest.fn() } as any,
      aggregation as unknown as AnalyticsAggregationService,
      cache as unknown as AnalyticsCacheService,
    );
    const processor = new AnalyticsProcessor(
      {} as never,
      daily,
      {} as never,
      {} as never,
      {} as never,
      queueService,
      new TenantContextService(),
      { assertAuthorized: jest.fn().mockResolvedValue(undefined) } as any,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    worker = new Worker(
      QUEUE.ANALYTICS,
      async (job: Job) => {
        // Contrast case: the pre-fix call shape (interactive semantics, no skip option).
        if (job.data.preFix) {
          return daily.generate(job.data.tenantId, { date: job.data.date });
        }
        return processor.process(job);
      },
      { connection, prefix, concurrency: 1 },
    );
  });

  afterAll(async () => {
    await worker?.close();
    await events?.close();
    for (const q of Object.values(queues ?? {})) {
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    }
  });

  afterEach(() => jest.clearAllMocks());

  const analytics = () => queues![QUEUE.ANALYTICS];

  it('pre-fix shape: the 422 is retried 5× and parked in failed (reproduces production)', async () => {
    if (!available) return console.warn(`SKIPPED: no Redis at ${REDIS_URL}`);
    aggregation.listActiveBranchIds.mockResolvedValue([]);

    const job = await analytics().add(
      JOB.ANALYTICS_GENERATE_REPORT,
      { tenantId: 't-empty', kind: 'daily', date: '2026-10-20', preFix: true },
      { ...jobOpts, jobId: 'analytics-daily-t-empty-2026-10-20' },
    );
    await expect(job.waitUntilFinished(events!, 10_000)).rejects.toThrow(
      'No active branches to generate a report for',
    );
    const after = await analytics().getJob(job.id!);
    expect(after!.attemptsMade).toBe(5);
    expect(await after!.getState()).toBe('failed');
    expect(aggregation.listActiveBranchIds).toHaveBeenCalledTimes(5);
  }, 20_000);

  it('fixed: the scheduled per-tenant job completes in ONE attempt as a recorded skip, writing nothing', async () => {
    if (!available) return console.warn(`SKIPPED: no Redis at ${REDIS_URL}`);
    aggregation.listActiveBranchIds.mockResolvedValue([]);

    const job = await analytics().add(
      JOB.ANALYTICS_GENERATE_REPORT,
      { tenantId: 't-empty', kind: 'daily', date: '2026-10-21' },
      { ...jobOpts, jobId: 'analytics-daily-t-empty-2026-10-21' },
    );
    await expect(job.waitUntilFinished(events!, 10_000)).resolves.toEqual({
      generated: [],
      failed: [],
      skipped: 'no_active_branches',
    });
    const after = await analytics().getJob(job.id!);
    expect(after!.attemptsMade).toBe(1);
    expect(await after!.getState()).toBe('completed');
    expect(aggregation.listActiveBranchIds).toHaveBeenCalledTimes(1);
    expect(cache.invalidate).not.toHaveBeenCalled();
  }, 20_000);

  it('fixed: a real transient error is still retried and, once exhausted, still lands in failed', async () => {
    if (!available) return console.warn(`SKIPPED: no Redis at ${REDIS_URL}`);
    aggregation.listActiveBranchIds.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.1:5432'),
    );

    const job = await analytics().add(
      JOB.ANALYTICS_GENERATE_REPORT,
      { tenantId: 't-db-down', kind: 'daily', date: '2026-10-21' },
      { ...jobOpts, jobId: 'analytics-daily-t-db-down-2026-10-21' },
    );
    await expect(job.waitUntilFinished(events!, 10_000)).rejects.toThrow('ECONNREFUSED');
    const after = await analytics().getJob(job.id!);
    expect(after!.attemptsMade).toBe(5);
    expect(after!.failedReason).toContain('ECONNREFUSED');
  }, 20_000);

  it('a transient error that clears on retry completes without a failed record', async () => {
    if (!available) return console.warn(`SKIPPED: no Redis at ${REDIS_URL}`);
    aggregation.listActiveBranchIds
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:5432'))
      .mockResolvedValue([]);

    const job = await analytics().add(
      JOB.ANALYTICS_GENERATE_REPORT,
      { tenantId: 't-blip', kind: 'daily', date: '2026-10-21' },
      { ...jobOpts, jobId: 'analytics-daily-t-blip-2026-10-21' },
    );
    await expect(job.waitUntilFinished(events!, 10_000)).resolves.toMatchObject({
      skipped: 'no_active_branches',
    });
    expect((await analytics().getJob(job.id!))!.attemptsMade).toBe(2);
  }, 20_000);

  it('queueCounts and failedSinceCounts match the real Redis state; the failed set is scored by finish time', async () => {
    if (!available) return console.warn(`SKIPPED: no Redis at ${REDIS_URL}`);
    await analytics().add('noop-delayed', {}, { delay: 60_000 });

    const counts = (await queueService.queueCounts())[QUEUE.ANALYTICS];
    // From the tests above: 2 failed (pre-fix + exhausted transient), 2 completed, 1 delayed.
    expect(counts).toMatchObject({ waiting: 0, active: 0, delayed: 1, completed: 2, failed: 2 });

    const failed = await analytics().getJob('analytics-daily-t-db-down-2026-10-21');
    const client = await analytics().client;
    const score = Number(await client.zscore(analytics().keys.failed, failed!.id!));
    expect(score).toBe(failed!.finishedOn);

    const recent = await queueService.failedSinceCounts(Date.now() - 24 * 3_600_000);
    expect(recent[QUEUE.ANALYTICS]).toBe(2);
    expect(recent[QUEUE.EMAIL]).toBe(0);
    // A window that starts after the failure no longer counts it as recent,
    // while the retained `failed` count is unchanged.
    const later = await queueService.failedSinceCounts(Date.now() + 1000);
    expect(later[QUEUE.ANALYTICS]).toBe(0);
    expect((await queueService.queueCounts())[QUEUE.ANALYTICS].failed).toBe(2);
  }, 20_000);
});
