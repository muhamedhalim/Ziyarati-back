import { QueueService } from './queue.service';
import { ProducerQueues } from './producer-queues';
import { TenantContextService } from '../core/tenant-context/tenant-context.service';
import { AppRedisService } from './app-redis.service';
import {
  ALL_QUEUES,
  QUEUE,
  JOB,
  PII_REMOVE_ON_FAIL_SECONDS,
  QueueName,
} from './queue.constants';

type MockBullQueue = {
  add: jest.Mock;
  addBulk: jest.Mock;
  getJob: jest.Mock;
  getJobCounts: jest.Mock;
};

describe('QueueService (producer facade)', () => {
  let service: QueueService;
  let record: Record<QueueName, MockBullQueue>;
  let ctx: { getCorrelationId: jest.Mock; getUser: jest.Mock };
  let appRedis: {
    application: {
      ping: jest.Mock;
      get: jest.Mock;
      set: jest.Mock;
      mget: jest.Mock;
    };
  };

  const makeQueue = (): MockBullQueue => ({
    add: jest.fn(async () => ({ id: 'job-1' })),
    addBulk: jest.fn(async () => [{ id: 'job-1' }]),
    getJob: jest.fn(async () => null),
    getJobCounts: jest.fn(async () => ({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    })),
  });

  beforeEach(() => {
    record = {} as Record<QueueName, MockBullQueue>;
    for (const name of ALL_QUEUES) record[name] = makeQueue();
    ctx = {
      getCorrelationId: jest.fn(() => 'cid-1'),
      getUser: jest.fn(() => ({ id: 'actor-1' })),
    };
    appRedis = {
      application: {
        ping: jest.fn().mockResolvedValue('PONG'),
        get: jest.fn().mockResolvedValue('v'),
        set: jest.fn().mockResolvedValue('OK'),
        mget: jest.fn().mockResolvedValue(['v1', null, 'v3']),
      },
    };
    const producers = { record: () => record } as unknown as ProducerQueues;
    service = new QueueService(
      producers,
      ctx as unknown as TenantContextService,
      appRedis as unknown as AppRedisService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('stamps tenant context (correlationId + actorId) and an idempotent jobId on enqueue', async () => {
    await service.enqueueNotificationDispatch({
      notificationId: 'n1',
      tenantId: 't1',
    } as any);

    expect(record[QUEUE.NOTIFICATIONS].add).toHaveBeenCalledWith(
      JOB.NOTIFICATIONS_DISPATCH,
      expect.objectContaining({
        notificationId: 'n1',
        tenantId: 't1',
        correlationId: 'cid-1',
        actorId: 'actor-1',
      }),
      expect.objectContaining({ jobId: 'notification-n1' }),
    );
  });

  it('preserves a correlationId already present on the payload', async () => {
    await service.enqueueNotificationDispatch({
      notificationId: 'n2',
      correlationId: 'pre-set',
    } as any);
    const [, data] = record[QUEUE.NOTIFICATIONS].add.mock.calls[0];
    expect(data.correlationId).toBe('pre-set');
  });

  it('builds a deterministic per-recipient jobId for the campaign hot path', async () => {
    await service.enqueueCampaignRecipient({
      runId: 'r1',
      recipientId: 'rec1',
      tenantId: 't1',
    } as any);
    expect(record[QUEUE.CAMPAIGNS_PROCESS].add).toHaveBeenCalledWith(
      JOB.CAMPAIGNS_PROCESS_RECIPIENT,
      expect.any(Object),
      expect.objectContaining({ jobId: 'campaign-recipient-r1-rec1' }),
    );
  });

  it('forces paid AI jobs to one BullMQ attempt with a deterministic idempotent job id', async () => {
    const data = {
      tenantId: 't1',
      aiConversationId: 'c1',
      content: 'hello',
      idempotencyKey: 'request-12345678',
    };
    await service.enqueueAiExecute(data);
    await service.enqueueAiExecute(data);
    const first = record[QUEUE.AI].add.mock.calls[0];
    const second = record[QUEUE.AI].add.mock.calls[1];
    expect(first[2]).toEqual(
      expect.objectContaining({
        attempts: 1,
        jobId: expect.stringMatching(/^ai-/),
      }),
    );
    expect(second[2].jobId).toBe(first[2].jobId);
    expect(first[2].jobId).not.toContain(':');
  });

  // Regression: every EmailService idempotency key (`invite:<token>`,
  // `verify:<token>`, `auto:<hash>`, …) contains ':'. BullMQ throws
  // synchronously on a custom job id containing ':' unless it splits into
  // exactly 3 segments — passing the raw key through as jobId crashed
  // `add()` on every real email send, and EmailService.send()'s best-effort
  // try/catch swallowed it silently (the job never reached Redis at all).
  it('sanitizes a colon-bearing idempotencyKey into a BullMQ-safe jobId, without mutating the payload field', async () => {
    await service.enqueueEmail({
      tenantId: 't1',
      to: 'agent@ziyaratech.com',
      template: 'staff_invitation',
      idempotencyKey: 'invite:abc123def456',
    } as any);

    const [, data, opts] = record[QUEUE.EMAIL].add.mock.calls[0];
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).toBe('email-invite_abc123def456');
    // EmailDeliveryService.claim() still needs the ORIGINAL, colon-bearing
    // key for its own DB-level idempotency check.
    expect(data.idempotencyKey).toBe('invite:abc123def456');
  });

  it.each([
    [
      'email',
      () =>
        service.enqueueEmail({
          tenantId: 't1',
          to: 'a@b.com',
          template: 'x',
        } as any),
      QUEUE.EMAIL,
    ],
    [
      'whatsapp send',
      () =>
        service.enqueueWhatsappSend({
          tenantId: 't1',
          templateId: 'tpl',
        } as any),
      QUEUE.WHATSAPP_OUTBOUND,
    ],
    [
      'whatsapp retry',
      () =>
        service.enqueueWhatsappRetry({
          tenantId: 't1',
          templateId: 'tpl',
        } as any),
      QUEUE.WHATSAPP_OUTBOUND,
    ],
    [
      'ai execute',
      () =>
        service.enqueueAiExecute({
          tenantId: 't1',
          aiConversationId: 'c1',
          content: 'hi',
          idempotencyKey: 'k1',
        } as any),
      QUEUE.AI,
    ],
  ])(
    'shortens removeOnFail retention for the PII-bearing %s payload (M1)',
    async (_label, call, queueName) => {
      await call();
      expect(record[queueName].add).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          removeOnFail: { age: PII_REMOVE_ON_FAIL_SECONDS, count: 10_000 },
        }),
      );
    },
  );

  it('registers a repeatable job with a cron pattern', async () => {
    await service.addRepeatable(
      QUEUE.ANALYTICS,
      JOB.ANALYTICS_AGGREGATE,
      { tenantId: null },
      '0 * * * *',
    );
    expect(record[QUEUE.ANALYTICS].add).toHaveBeenCalledWith(
      JOB.ANALYTICS_AGGREGATE,
      expect.any(Object),
      expect.objectContaining({ repeat: { pattern: '0 * * * *' } }),
    );
  });

  it('removes a scheduled notification job by its deterministic id', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    record[QUEUE.NOTIFICATIONS].getJob.mockResolvedValueOnce({ remove });
    await service.removeNotificationDispatch('n1');
    expect(record[QUEUE.NOTIFICATIONS].getJob).toHaveBeenCalledWith(
      'notification-n1',
    );
    expect(remove).toHaveBeenCalled();
  });

  it('reports the DLQ depth (waiting + delayed)', async () => {
    record[QUEUE.CAMPAIGNS_DLQ].getJobCounts.mockResolvedValueOnce({
      waiting: 2,
      delayed: 1,
    });
    await expect(service.dlqDepth()).resolves.toBe(3);
  });

  describe('typed producers route to the correct queue', () => {
    it.each<[string, () => Promise<unknown>, QueueName]>([
      [
        'whatsapp send',
        () => service.enqueueWhatsappSend({ tenantId: 't1' } as any),
        QUEUE.WHATSAPP_OUTBOUND,
      ],
      [
        'whatsapp retry',
        () => service.enqueueWhatsappRetry({ tenantId: 't1' } as any),
        QUEUE.WHATSAPP_OUTBOUND,
      ],
      [
        'campaign launch',
        () => service.enqueueCampaignLaunch({ runId: 'r1' } as any),
        QUEUE.CAMPAIGNS_LAUNCH,
      ],
      [
        'campaign fanout',
        () => service.enqueueCampaignFanoutChunk({ runId: 'r1' } as any),
        QUEUE.CAMPAIGNS_FANOUT,
      ],
      [
        'ai execute',
        () => service.enqueueAiExecute({ tenantId: 't1' } as any),
        QUEUE.AI,
      ],
      [
        'analytics aggregate',
        () => service.enqueueAnalyticsAggregate({ tenantId: null } as any),
        QUEUE.ANALYTICS,
      ],
      [
        'analytics report',
        () => service.enqueueAnalyticsReport({ tenantId: null } as any),
        QUEUE.ANALYTICS,
      ],
      [
        'analytics cleanup',
        () => service.enqueueAnalyticsCleanup({ tenantId: null } as any),
        QUEUE.ANALYTICS,
      ],
      [
        'settlements',
        () => service.enqueueSettlementsProcess({ tenantId: 't1' } as any),
        QUEUE.SETTLEMENTS,
      ],
      [
        'subscriptions',
        () =>
          service.enqueueSubscriptionsRenewalCheck({ tenantId: null } as any),
        QUEUE.SUBSCRIPTIONS,
      ],
      [
        'refunds',
        () => service.enqueueRefundsReap({ tenantId: null } as any),
        QUEUE.REFUNDS,
      ],
    ])('%s', async (_label, call, queueName) => {
      await call();
      expect(record[queueName].add).toHaveBeenCalled();
    });
  });

  describe('campaign launch / fanout idempotent ids', () => {
    it('builds campaign-launch-<runId>', async () => {
      await service.enqueueCampaignLaunch({ runId: 'r9' } as any);
      expect(record[QUEUE.CAMPAIGNS_LAUNCH].add).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ jobId: 'campaign-launch-r9' }),
      );
    });

    it('never builds a jobId containing ":" — BullMQ rejects custom ids with a colon unless they split into exactly 3 parts', async () => {
      await service.enqueueNotificationDispatch({
        notificationId: 'n1',
        tenantId: 't1',
      } as any);
      await service.enqueueCampaignLaunch({ runId: 'r9' } as any);
      await service.enqueueCampaignRecipient({
        runId: 'r1',
        recipientId: 'rec1',
        tenantId: 't1',
      } as any);
      for (const queue of [
        QUEUE.NOTIFICATIONS,
        QUEUE.CAMPAIGNS_LAUNCH,
        QUEUE.CAMPAIGNS_PROCESS,
      ]) {
        for (const call of record[queue].add.mock.calls) {
          const jobId = (call[2] as { jobId?: string })?.jobId;
          if (jobId) expect(jobId).not.toContain(':');
        }
      }
    });

    it('bulk-enqueues recipient jobs in one round trip', async () => {
      await service.enqueueCampaignRecipientsBulk([
        { data: { runId: 'r1', recipientId: 'a', tenantId: 't1' } as any },
        { data: { runId: 'r1', recipientId: 'b', tenantId: 't1' } as any },
      ]);
      expect(record[QUEUE.CAMPAIGNS_PROCESS].addBulk).toHaveBeenCalled();
    });

    it('parks a dead-letter job in the campaigns DLQ', async () => {
      await service.enqueueCampaignDlq({
        sourceQueue: QUEUE.CAMPAIGNS_PROCESS,
        tenantId: 't1',
      } as any);
      expect(record[QUEUE.CAMPAIGNS_DLQ].add).toHaveBeenCalled();
    });
  });

  describe('sweep fan-out bulk enqueue with deterministic jobIds (M7)', () => {
    it('bulk-enqueues analytics.aggregate with one deterministic jobId per tenant', async () => {
      await service.enqueueAnalyticsAggregateBulk(['t1', 't2']);
      expect(record[QUEUE.ANALYTICS].addBulk).toHaveBeenCalledWith([
        expect.objectContaining({ opts: { jobId: 'analytics-aggregate-t1' } }),
        expect.objectContaining({ opts: { jobId: 'analytics-aggregate-t2' } }),
      ]);
    });

    it('is a no-op (no addBulk call) for an empty tenant list', async () => {
      await service.enqueueAnalyticsAggregateBulk([]);
      expect(record[QUEUE.ANALYTICS].addBulk).not.toHaveBeenCalled();
    });

    it('bulk-enqueues analytics.generateReport with a (tenant, date) deterministic jobId', async () => {
      await service.enqueueAnalyticsReportBulk([
        { tenantId: 't1', date: '2026-07-01' },
        { tenantId: 't2', date: '2026-07-01' },
      ]);
      expect(record[QUEUE.ANALYTICS].addBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          opts: { jobId: 'analytics-daily-t1-2026-07-01' },
        }),
        expect.objectContaining({
          opts: { jobId: 'analytics-daily-t2-2026-07-01' },
        }),
      ]);
    });

    it('bulk-enqueues settlements.process with a (tenant, periodStart) deterministic jobId', async () => {
      await service.enqueueSettlementsProcessBulk([
        { tenantId: 't1', periodStart: '2026-07-01' } as any,
        { tenantId: 't2' } as any, // no periodStart -> falls back to 'default'
      ]);
      expect(record[QUEUE.SETTLEMENTS].addBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          opts: { jobId: 'settlements-t1-2026-07-01' },
        }),
        expect.objectContaining({ opts: { jobId: 'settlements-t2-default' } }),
      ]);
    });
  });

  describe('relay + health helpers', () => {
    it('publish() uses the dedupeKey as the jobId', async () => {
      await service.publish(
        QUEUE.ANALYTICS,
        'some.job',
        { tenantId: 't1' } as any,
        'dedupe-9',
      );
      expect(record[QUEUE.ANALYTICS].add).toHaveBeenCalledWith(
        'some.job',
        expect.any(Object),
        expect.objectContaining({ jobId: 'dedupe-9' }),
      );
    });

    it('redisPing returns a latency number', async () => {
      await expect(service.redisPing()).resolves.toEqual(expect.any(Number));
    });

    it('dlqDepth defaults to the campaigns DLQ but accepts any queue', async () => {
      record[QUEUE.CAMPAIGNS_DLQ].getJobCounts.mockResolvedValueOnce({
        waiting: 1,
        delayed: 0,
      });
      await expect(service.dlqDepth()).resolves.toBe(1);

      record[QUEUE.WHATSAPP_DLQ].getJobCounts.mockResolvedValueOnce({
        waiting: 2,
        delayed: 1,
      });
      await expect(service.dlqDepth(QUEUE.WHATSAPP_DLQ)).resolves.toBe(3);
    });

    it('kvSet / kvGet proxy the dedicated application Redis client (not a BullMQ producer connection)', async () => {
      await service.kvSet('k', 'v', 60);
      expect(appRedis.application.set).toHaveBeenCalledWith('k', 'v', 'EX', 60);
      await expect(service.kvGet('k')).resolves.toBe('v');
      expect(appRedis.application.get).toHaveBeenCalledWith('k');
    });

    it('kvMget does one MGET round trip for N keys (M5)', async () => {
      await expect(service.kvMget(['k1', 'k2', 'k3'])).resolves.toEqual([
        'v1',
        null,
        'v3',
      ]);
      expect(appRedis.application.mget).toHaveBeenCalledWith('k1', 'k2', 'k3');
      expect(appRedis.application.mget).toHaveBeenCalledTimes(1);
    });

    it('kvMget short-circuits on an empty key list without calling Redis', async () => {
      await expect(service.kvMget([])).resolves.toEqual([]);
      expect(appRedis.application.mget).not.toHaveBeenCalled();
    });

    it('queueCounts aggregates job counts across all queues', async () => {
      const counts = await service.queueCounts();
      expect(Object.keys(counts).length).toBe(ALL_QUEUES.length);
    });
  });
});
