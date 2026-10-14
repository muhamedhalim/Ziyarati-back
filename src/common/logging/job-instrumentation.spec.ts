import { Logger } from '@nestjs/common';
import { ProcessorDecoratorService } from '@nestjs/bullmq';
import {
  DelayedError,
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
  type Job,
} from 'bullmq';
import IORedis from 'ioredis';

import {
  installJobInstrumentation,
  instrumentProcessor,
  setJobMetricsSink,
} from './job-instrumentation';
import { StructuredLogger } from './structured-logger';

function captureLogs() {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    role: 'worker',
    env: { NODE_ENV: 'production', LOG_LEVEL: 'debug' },
    destination: { write: (s: string) => void lines.push(s) },
  });
  Logger.overrideLogger(logger);
  return () => lines.map((l) => JSON.parse(l) as Record<string, any>);
}

const TENANT = '0b9c4f7e-1d2a-4e3b-8c5d-6f7a8b9c0d1e';

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    queueName: 'email',
    name: 'email.send',
    id: '42',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      tenantId: TENANT,
      correlationId: 'req-1',
      to: 'patient.fake@example.com',
      body: 'private text',
    },
    ...overrides,
  } as unknown as Job;
}

describe('job instrumentation (unit)', () => {
  let records: () => Record<string, any>[];
  const observed: Array<[string, string]> = [];

  beforeEach(() => {
    records = captureLogs();
    observed.length = 0;
    setJobMetricsSink({
      observeJob: (queue, outcome) => void observed.push([queue, outcome]),
    });
  });
  afterAll(() => {
    setJobMetricsSink(undefined);
    Logger.overrideLogger(['error']);
  });

  it('logs start/completion at debug with job fields and never the payload', async () => {
    const wrapped = instrumentProcessor(async () => {
      new Logger('EmailProcessor').log('sending');
      return 'ok';
    });
    await expect(wrapped(fakeJob())).resolves.toBe('ok');

    const rs = records();
    expect(rs.map((r) => r.event)).toEqual([
      'job.processing.started',
      'email_processor.log',
      'job.processing.completed',
    ]);
    for (const r of rs) {
      expect(r).toMatchObject({
        queue: 'email',
        job_name: 'email.send',
        job_id: '42',
        attempt: 1,
      });
    }
    expect(rs[0]).toMatchObject({
      tenant_id: TENANT,
      request_id: 'req-1',
      level: 'debug',
    });
    expect(typeof rs[2].duration_ms).toBe('number');
    const out = JSON.stringify(rs);
    expect(out).not.toContain('patient.fake@example.com');
    expect(out).not.toContain('private text');
    expect(observed).toEqual([['email', 'completed']]);
  });

  it('logs a retry (attempt 1 of 3) once at warn, not error', async () => {
    const wrapped = instrumentProcessor(async () => {
      throw new Error('smtp timeout');
    });
    await expect(wrapped(fakeJob())).rejects.toThrow('smtp timeout');
    const failures = records().filter(
      (r) => r.level === 'warn' || r.level === 'error',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: 'warn',
      event: 'job.processing.retry_scheduled',
      attempt: 1,
      max_attempts: 3,
      error: { type: 'Error', message: 'smtp timeout' },
    });
    expect(observed).toEqual([['email', 'retry']]);
  });

  it('logs the final attempt once at error, keeping the "failed job=" phrase', async () => {
    const wrapped = instrumentProcessor(async () => {
      throw new Error('smtp down');
    });
    await expect(wrapped(fakeJob({ attemptsMade: 2 }))).rejects.toThrow();
    const [failed] = records().filter((r) => r.level === 'error');
    expect(failed).toMatchObject({
      event: 'job.processing.failed',
      attempt: 3,
      exhausted: true,
      unrecoverable: false,
    });
    expect(failed.message).toContain('failed job=42');
    expect(failed.error.stack).toContain('Error: smtp down');
    expect(observed).toEqual([['email', 'failed']]);
  });

  it('treats UnrecoverableError as final on the first attempt', async () => {
    const wrapped = instrumentProcessor(async () => {
      throw new UnrecoverableError('payload invalid');
    });
    await expect(wrapped(fakeJob())).rejects.toThrow();
    const [failed] = records().filter((r) => r.level === 'error');
    expect(failed).toMatchObject({
      event: 'job.processing.failed',
      attempt: 1,
      exhausted: false,
      unrecoverable: true,
    });
  });

  it('treats DelayedError as flow control (debug, no failure)', async () => {
    const wrapped = instrumentProcessor(async () => {
      throw new DelayedError();
    });
    await expect(wrapped(fakeJob())).rejects.toBeInstanceOf(DelayedError);
    expect(
      records().filter((r) => r.level === 'warn' || r.level === 'error'),
    ).toHaveLength(0);
    expect(records().some((r) => r.event === 'job.processing.deferred')).toBe(
      true,
    );
    expect(observed).toEqual([['email', 'deferred']]);
  });

  it('drops a malformed tenant id / correlation id from the lifecycle fields', async () => {
    const wrapped = instrumentProcessor(async () => 'ok');
    await wrapped(
      fakeJob({
        data: { tenantId: 'not-a-uuid', correlationId: 'bad id with spaces' },
      } as any),
    );
    const [started] = records();
    expect(started.tenant_id).toBeUndefined();
    expect(started.request_id).toBeUndefined();
  });

  it('patches @nestjs/bullmq so every processor it builds is wrapped', async () => {
    installJobInstrumentation();
    installJobInstrumentation(); // idempotent
    const decorated = new ProcessorDecoratorService().decorate(
      async () => 'done',
    );
    await expect(decorated(fakeJob() as any, undefined as any)).resolves.toBe(
      'done',
    );
    expect(records().map((r) => r.event)).toEqual([
      'job.processing.started',
      'job.processing.completed',
    ]);
  });
});

/**
 * A real BullMQ Worker against a local Redis (the disposable e2e container on
 * :63790, or REDIS_TEST_URL). Isolated under a unique key prefix and
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

describe('job instrumentation (real BullMQ + Redis)', () => {
  let available = false;
  const prefix = `logtest-${process.pid}-${Date.now()}`;
  const queueName = 'instrumented';
  let queue: Queue | undefined;
  let worker: Worker | undefined;
  let events: QueueEvents | undefined;
  let records: () => Record<string, any>[];

  beforeAll(async () => {
    available = await redisAvailable();
  });

  afterAll(async () => {
    await worker?.close();
    await events?.close();
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    Logger.overrideLogger(['error']);
  });

  it('logs success, retry and exhausted failure from real job runs', async () => {
    if (!available) {
      console.warn(`SKIPPED: no Redis at ${REDIS_URL}`);
      return;
    }
    records = captureLogs();
    const connection = { url: REDIS_URL, maxRetriesPerRequest: null };
    queue = new Queue(queueName, { connection, prefix });
    events = new QueueEvents(queueName, { connection, prefix });
    await events.waitUntilReady();

    worker = new Worker(
      queueName,
      instrumentProcessor(async (job: Job) => {
        if (job.name === 'always-fails')
          throw new Error(`provider down (attempt ${job.attemptsMade + 1})`);
        return 'ok';
      }),
      { connection, prefix, concurrency: 1 },
    );

    const ok = await queue.add(
      'succeeds',
      { tenantId: TENANT },
      { attempts: 1 },
    );
    const bad = await queue.add(
      'always-fails',
      { tenantId: TENANT },
      { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
    );
    await expect(ok.waitUntilFinished(events, 10_000)).resolves.toBe('ok');
    await expect(bad.waitUntilFinished(events, 10_000)).rejects.toThrow(
      'provider down',
    );

    const rs = records().filter((r) => r.queue === queueName);
    const lifecycle = rs.map((r) => [r.job_name, r.event, r.attempt]);
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        ['succeeds', 'job.processing.completed', 1],
        ['always-fails', 'job.processing.retry_scheduled', 1],
        ['always-fails', 'job.processing.failed', 2],
      ]),
    );
    // Exactly one error line for the exhausted job — no duplicate failure logs.
    expect(rs.filter((r) => r.level === 'error')).toHaveLength(1);
    expect(rs.find((r) => r.event === 'job.processing.failed')?.job_id).toBe(
      bad.id,
    );
  }, 20_000);
});
