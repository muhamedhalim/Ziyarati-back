/**
 * OFFLINE integration test — real Redis + real BullMQ, driving the REAL email
 * pipeline end to end:
 *
 *   EmailService.sendInvitation → QueueService.enqueueEmail (real producer)
 *   → Redis → BullMQ Worker → EmailDeliveryService.deliver (real)
 *   → SesProvider.send (real; only the AWS SESv2 client is stubbed) → job state
 *
 * Pins the 2026-09 production incident: the provider rejected every email
 * (worker EMAIL_FROM="") while every BullMQ job reported COMPLETED. The
 * `email_logs` claim/record layer is an in-memory stand-in (Postgres is not
 * the subject here — its atomic claim is covered by the unit spec).
 *
 * Needs a reachable Redis (REDIS_URL, default redis://127.0.0.1:6379). Unlike
 * queue.int-spec.ts this FAILS rather than silently passing when Redis is
 * down — a green run must mean the pipeline was actually exercised.
 *
 * Run: npx jest --config test/jest-integration.json email-pipeline
 */
const sesSendMock = jest.fn();
jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: sesSendMock })),
  SendEmailCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

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
import { SesProvider } from '../../src/modules/email/providers/ses.provider';
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
  AWS_REGION: 'eu-central-1',
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

const awsError = (name: string, status: number) =>
  Object.assign(new Error(`${name} happened`), {
    name,
    $metadata: { httpStatusCode: status },
  });

describe('Email pipeline — real Redis + BullMQ (production incident regression)', () => {
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
    sesSendMock.mockReset();
    await admin.obliterate({ force: true });
    logs = fakeEmailLogs();
    const factory = new EmailProviderFactory(
      config,
      new NoopEmailProvider(),
      new SesProvider(config),
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

  it('a PERMANENT provider rejection (SES MessageRejected) ends the job FAILED after ONE attempt — never "completed"', async () => {
    sesSendMock.mockRejectedValue(awsError('MessageRejected', 400));
    const w = startWorker();
    const done = settle(w, expectedJobId());
    await invite();

    expect(await done).toBe('failed');
    const job = await admin.getJob(expectedJobId());
    expect(await job!.getState()).toBe('failed');
    expect(job!.attemptsMade).toBe(1); // attempts=3 configured — no retry of a permanent error
    expect(job!.failedReason).toContain('MessageRejected');
    expect(sesSendMock).toHaveBeenCalledTimes(1);
    expect([...logs.rows.values()][0].status).toBe('FAILED');
  });

  it('a TRANSIENT failure (503) is retried and then COMPLETES', async () => {
    sesSendMock
      .mockRejectedValueOnce(awsError('ServiceUnavailable', 503))
      .mockResolvedValueOnce({ MessageId: 'ses_msg_1' });
    const w = startWorker();
    const done = settle(w, expectedJobId());
    await invite();

    expect(await done).toBe('completed');
    const job = await admin.getJob(expectedJobId());
    expect(job!.attemptsMade).toBe(2);
    expect(sesSendMock).toHaveBeenCalledTimes(2);
    expect(sesSendMock.mock.calls[1][0].input.FromEmailAddress).toBe(
      'ZiyaraTech <no-reply@ziyaratech.com>',
    );
    expect([...logs.rows.values()][0].status).toBe('SENT');
  });

  it('a duplicate enqueue of the same invitation is collapsed — one job, one email', async () => {
    sesSendMock.mockResolvedValue({ MessageId: 'ses_msg_1' });
    await invite();
    await invite(); // double-submit / retried HTTP request
    expect((await admin.getJobCounts('waiting')).waiting).toBe(1);

    const w = startWorker();
    const done = settle(w, expectedJobId());
    expect(await done).toBe('completed');
    expect(sesSendMock).toHaveBeenCalledTimes(1);
  });

  it('a job enqueued while NO worker runs is delivered once a worker starts (restart does not lose jobs)', async () => {
    sesSendMock.mockResolvedValue({ MessageId: 'ses_msg_1' });
    await invite();
    expect((await admin.getJobCounts('waiting')).waiting).toBe(1);

    const w = startWorker(); // "worker came back after a deploy"
    expect(await settle(w, expectedJobId())).toBe('completed');
  });

  it('the raw credential token is absent from Redis key names, the job id and the email_logs key (the job DATA still carries the link — it must, to render the email)', async () => {
    sesSendMock.mockResolvedValue({ MessageId: 'ses_msg_1' });
    await invite();

    const redis = new IORedis(REDIS_URL);
    try {
      const keys = await redis.keys(`${PREFIX}:*`);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.join('\n')).not.toContain(RAW_TOKEN);

      // Job DATA: no separate `token` field; the raw token appears exactly
      // once — inside the link the template must render.
      const data = await redis.hget(
        `${PREFIX}:email:${expectedJobId()}`,
        'data',
      );
      const parsed = JSON.parse(data as string);
      expect(parsed.variables).not.toHaveProperty('token');
      expect((data as string).split(RAW_TOKEN).length - 1).toBe(1);
      // BullMQ's events stream records job ids — it must hold only the hash.
      const events = await redis.xrange(`${PREFIX}:email:events`, '-', '+');
      expect(JSON.stringify(events)).not.toContain(RAW_TOKEN);
    } finally {
      redis.disconnect();
    }
    const w = startWorker();
    await settle(w, expectedJobId());
    expect([...logs.rows.keys()].join('\n')).not.toContain(RAW_TOKEN);
  });
});
