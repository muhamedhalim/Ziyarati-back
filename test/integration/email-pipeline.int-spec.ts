/**
 * OFFLINE integration test — real Redis + real BullMQ, driving the REAL email
 * pipeline end to end:
 *
 *   EmailService.sendInvitation → QueueService.enqueueEmail (real producer)
 *   → Redis → BullMQ Worker → EmailDeliveryService.deliver (real)
 *   → ResendProvider.send (real; only `fetch` is stubbed) → job state
 *
 * Pins the 2026-09 production incident: Resend rejected every email with a
 * 422 (worker EMAIL_FROM="") while every BullMQ job reported COMPLETED. The
 * `email_logs` claim/record layer is an in-memory stand-in (Postgres is not
 * the subject here — its atomic claim is covered by the unit spec).
 *
 * Needs a reachable Redis (REDIS_URL, default redis://127.0.0.1:6379). Unlike
 * queue.int-spec.ts this FAILS rather than silently passing when Redis is
 * down — a green run must mean the pipeline was actually exercised.
 *
 * Run: npx jest --config test/jest-integration.json email-pipeline
 */
import { createHash, randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { Logger } from '@nestjs/common';

import { ProducerQueues } from '../../src/queue/producer-queues';
import { QueueService } from '../../src/queue/queue.service';
import { QUEUE } from '../../src/queue/queue.constants';
import { EmailService } from '../../src/modules/email/email.service';
import { EmailDeliveryService } from '../../src/modules/email/email-delivery.service';
import { EmailProviderFactory } from '../../src/modules/email/providers/email-provider.factory';
import { ResendProvider } from '../../src/modules/email/providers/resend.provider';
import { NoopEmailProvider } from '../../src/modules/email/providers/noop-email.provider';
import { EmailSendJob } from '../../src/queue/job-data.interface';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const PREFIX = `zt-email-int-${randomUUID().slice(0, 8)}`;
const RAW_TOKEN =
  randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

const env: Record<string, unknown> = {
  REDIS_URL,
  NODE_ENV: 'test',
  EMAIL_ENABLED: 'true',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'no-reply@ziyaratech.com',
  EMAIL_FROM_NAME: 'ZiyaraTech',
  QUEUE_DEFAULT_ATTEMPTS: 3,
  QUEUE_BACKOFF_MS: 50,
  FRONTEND_ORIGIN: 'https://app.example.com',
};
const config = {
  get: jest.fn((k: string, d?: unknown) => (k in env ? env[k] : d)),
} as never;

/** In-memory stand-in for `email_logs` + its atomic claim (single process). */
function fakeEmailLogs() {
  const rows = new Map<string, { status: string; attempts: number }>();
  const manager = {
    query: jest.fn(async (sql: string, [key]: [string]) => {
      if (sql.startsWith('INSERT')) {
        if (rows.has(key)) return [];
        rows.set(key, { status: 'QUEUED', attempts: 0 });
        return [{ id: key }];
      }
      return [{ status: rows.get(key)?.status }];
    }),
  };
  const repo = {
    findOne: jest.fn(
      async ({ where }: { where: { idempotency_key: string } }) =>
        rows.has(where.idempotency_key)
          ? {
              idempotency_key: where.idempotency_key,
              ...rows.get(where.idempotency_key),
            }
          : null,
    ),
    create: jest.fn((x: Record<string, unknown>) => ({ ...x })),
    save: jest.fn(
      async (log: {
        idempotency_key: string;
        status: string;
        attempts: number;
      }) => {
        rows.set(log.idempotency_key, {
          status: log.status,
          attempts: log.attempts,
        });
        return log;
      },
    ),
  };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)),
  };
  return { rows, repo, dataSource };
}

type FetchReply = { status: number; body: string };
const reply = ({ status, body }: FetchReply) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  text: async () => body,
  json: async () => JSON.parse(body),
});

describe('Email pipeline — real Redis + BullMQ (production incident regression)', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let producers: ProducerQueues;
  let queueService: QueueService;
  let emailService: EmailService;
  let logs: ReturnType<typeof fakeEmailLogs>;
  let delivery: EmailDeliveryService;
  let worker: Worker | undefined;
  let admin: Queue;
  const workerConn = () => {
    const u = new URL(REDIS_URL);
    return {
      host: u.hostname,
      port: Number(u.port || 6379),
      maxRetriesPerRequest: null as null,
    };
  };

  beforeAll(async () => {
    const probe = new IORedis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    try {
      await probe.connect();
      await probe.ping();
    } finally {
      probe.disconnect();
    }
    process.env.QUEUE_ENV_PREFIX = PREFIX;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    admin = new Queue(QUEUE.EMAIL, {
      connection: workerConn(),
      prefix: PREFIX,
    });
  });

  beforeEach(async () => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    await admin.obliterate({ force: true });
    logs = fakeEmailLogs();
    const factory = new EmailProviderFactory(
      config,
      new ResendProvider(config),
      new NoopEmailProvider(),
    );
    delivery = new EmailDeliveryService(
      logs.repo as never,
      factory,
      config,
      logs.dataSource as never,
    );
    producers = new ProducerQueues(config);
    queueService = new QueueService(
      producers,
      { getCorrelationId: () => 'cid-int', getUser: () => undefined } as never,
      {} as never,
      config,
    );
    emailService = new EmailService(queueService, delivery, config);
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await worker?.close();
    worker = undefined;
    await producers.onModuleDestroy?.();
  });

  afterAll(async () => {
    await admin.obliterate({ force: true });
    await admin.close();
    delete process.env.QUEUE_ENV_PREFIX;
    jest.restoreAllMocks();
  });

  const startWorker = () => {
    worker = new Worker(
      QUEUE.EMAIL,
      async (job: Job<EmailSendJob>) => {
        await delivery.deliver(job.data);
        return { ok: true };
      },
      { connection: workerConn(), prefix: PREFIX },
    );
    return worker;
  };

  const settle = (w: Worker, jobId: string) =>
    new Promise<'completed' | 'failed'>((resolve) => {
      w.on('completed', (j) => j.id === jobId && resolve('completed'));
      w.on('failed', (j, err) => {
        // Only a FINAL failure settles; intermediate retries keep waiting.
        if (
          j?.id === jobId &&
          (err?.name === 'UnrecoverableError' ||
            j.attemptsMade >= (j.opts.attempts ?? 1))
        )
          resolve('failed');
      });
    });

  const invite = () =>
    emailService.sendInvitation({
      to: 'new.hire@clinic.com',
      invitationUrl: `https://app.example.com/auth/reset-password?token=${RAW_TOKEN}`,
      token: RAW_TOKEN,
      tenantId: randomUUID(),
    });

  const expectedJobId = () =>
    `email-invite_${createHash('sha256').update(RAW_TOKEN).digest('hex')}`;

  it('a PERMANENT provider rejection (the production 422) ends the job FAILED after ONE attempt — never "completed"', async () => {
    fetchMock.mockResolvedValue(
      reply({
        status: 422,
        body: '{"statusCode":422,"name":"validation_error","message":"Invalid `from` field."}',
      }),
    );
    const w = startWorker();
    const done = settle(w, expectedJobId());
    await invite();

    expect(await done).toBe('failed');
    const job = await admin.getJob(expectedJobId());
    expect(await job!.getState()).toBe('failed');
    expect(job!.attemptsMade).toBe(1); // attempts=3 configured — no retry of a permanent error
    expect(job!.failedReason).toContain('HTTP 422');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...logs.rows.values()][0].status).toBe('FAILED');
  });

  it('a TRANSIENT failure (503) is retried and then COMPLETES, reusing the same Idempotency-Key', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ status: 503, body: 'unavailable' }))
      .mockResolvedValueOnce(reply({ status: 200, body: '{"id":"re_msg_1"}' }));
    const w = startWorker();
    const done = settle(w, expectedJobId());
    await invite();

    expect(await done).toBe('completed');
    const job = await admin.getJob(expectedJobId());
    expect(job!.attemptsMade).toBe(2);
    const keys = fetchMock.mock.calls.map(
      (c) => c[1].headers['Idempotency-Key'],
    );
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).from).toBe(
      'ZiyaraTech <no-reply@ziyaratech.com>',
    );
    expect([...logs.rows.values()][0].status).toBe('SENT');
  });

  it('a duplicate enqueue of the same invitation is collapsed — one job, one email', async () => {
    fetchMock.mockResolvedValue(
      reply({ status: 200, body: '{"id":"re_msg_1"}' }),
    );
    await invite();
    await invite(); // double-submit / retried HTTP request
    expect((await admin.getJobCounts('waiting')).waiting).toBe(1);

    const w = startWorker();
    const done = settle(w, expectedJobId());
    expect(await done).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a job enqueued while NO worker runs is delivered once a worker starts (restart does not lose jobs)', async () => {
    fetchMock.mockResolvedValue(
      reply({ status: 200, body: '{"id":"re_msg_1"}' }),
    );
    await invite();
    expect((await admin.getJobCounts('waiting')).waiting).toBe(1);

    const w = startWorker(); // "worker came back after a deploy"
    expect(await settle(w, expectedJobId())).toBe('completed');
  });

  it('the raw credential token is absent from Redis key names, the job id and the email_logs key (the job DATA still carries the link — it must, to render the email)', async () => {
    fetchMock.mockResolvedValue(
      reply({ status: 200, body: '{"id":"re_msg_1"}' }),
    );
    await invite();

    const redis = new IORedis(REDIS_URL);
    try {
      const keys = await redis.keys(`${PREFIX}:*`);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.join('\n')).not.toContain(RAW_TOKEN);
    } finally {
      redis.disconnect();
    }
    const w = startWorker();
    await settle(w, expectedJobId());
    expect([...logs.rows.keys()].join('\n')).not.toContain(RAW_TOKEN);
  });
});
