/**
 * FND-022 — real-Redis/BullMQ suite proving that a WhatsApp outbound send
 * failure currently reaches neither a real BullMQ retry nor the WHATSAPP_DLQ.
 *
 * Verified root cause: `WhatsappExecutionService.sendTemplateMessage` CATCHES
 * a provider send error and RETURNS `{ status: 'FAILED', error }` — it never
 * throws for a provider-level failure (whatsapp-execution.service.ts:170-179).
 * `WhatsappProcessor.process()` (worker/processors/whatsapp.processor.ts)
 * simply returns whatever `sendTemplateMessage` resolves to. A NestJS BullMQ
 * `WorkerHost.process()` that RETURNS (rather than throws) is exactly what
 * marks the job `completed` — so BullMQ's attempts/backoff never engage, and
 * `onFailed` (which today does nothing but log) never fires.
 *
 * WHAT IS REAL vs STUBBED (same principle `dlq-replay-idempotency.e2e-spec.ts`
 * documents): a genuine, repeatable Meta provider failure cannot be produced
 * on demand from a test, so `WhatsappExecutionService.sendTemplateMessage` is
 * stubbed to a deterministic `{status: 'FAILED'}` — analogous to that suite
 * spying on `QueueService.publish` for one rejected call. Every part of the
 * property actually under test — job scheduling, BullMQ's real attempts/
 * backoff retry engine, and the WHATSAPP_DLQ park — runs against REAL Redis
 * via a REAL BullMQ `Queue` + `Worker`, using the SAME `WhatsappProcessor`
 * class the worker process registers in production (`worker.module.ts`).
 * `WorkerAuthorizationService` is stubbed to always authorize — worker
 * authorization is FND-036's concern (see notification/email processor
 * suites), not this finding's.
 *
 * This suite intentionally does NOT boot `AppModule` or `WorkerModule` (both
 * pull in Postgres, OpenAI, storage, and every other domain module) — it
 * builds the minimal real BullMQ wiring `WhatsappProcessor` actually needs.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { WhatsappProcessor } from '../src/worker/processors/whatsapp.processor';
import { WhatsappExecutionService } from '../src/modules/whatsapp/whatsapp-execution.service';
import { WhatsappCoexistenceSyncService } from '../src/modules/whatsapp/meta/whatsapp-coexistence-sync.service';
import { TenantContextService } from '../src/core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../src/queue/worker-authorization.service';
import { QueueService } from '../src/queue/queue.service';
import { QUEUE, JOB, bullPrefix } from '../src/queue/queue.constants';
import { blockingConnectionOptions } from '../src/queue/redis.config';
import type { WhatsappSendJob, WhatsappDlqJob } from '../src/queue/job-data.interface';
import { WHATSAPP_DELIVERY_STATUS } from '../src/modules/whatsapp/whatsapp.constants';

const SUITE_MARKER = `t027-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `${SUITE_MARKER}-tenant`;

/** Polls until the job leaves the active/waiting/delayed states, or times out. */
async function waitForTerminal(queue: Queue, jobId: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await queue.getJob(jobId);
    if (!job) return 'missing';
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') return state;
    if (Date.now() > deadline) return state; // best-effort — assertion will show it
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('WhatsApp outbound send — provider failure must reach WHATSAPP_DLQ (FND-022, real Redis + real BullMQ)', () => {
  let moduleRef: TestingModule;
  let sendQueue: Queue;
  let dlqQueue: Queue;
  let execution: { sendTemplateMessage: jest.Mock };
  let worker: Worker;

  beforeAll(async () => {
    execution = { sendTemplateMessage: jest.fn() };
    const authz: Pick<WorkerAuthorizationService, 'assertAuthorized'> = {
      assertAuthorized: jest.fn().mockResolvedValue(undefined),
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
        BullModule.forRootAsync({
          useFactory: (config: ConfigService) => ({
            connection: blockingConnectionOptions(config),
            prefix: bullPrefix(),
          }),
          inject: [ConfigService],
        }),
        BullModule.registerQueue(
          { name: QUEUE.WHATSAPP_OUTBOUND },
          { name: QUEUE.WHATSAPP_DLQ },
        ),
      ],
      providers: [
        WhatsappProcessor,
        { provide: WhatsappExecutionService, useValue: execution },
        // The processor's 5th dependency (coexistence history sync). These specs exercise failed-send
        // routing to the DLQ only, so an inert stand-in is the right size of fake.
        { provide: WhatsappCoexistenceSyncService, useValue: { run: jest.fn() } },
        TenantContextService,
        { provide: WorkerAuthorizationService, useValue: authz },
        // A REAL-Redis-backed stand-in for QueueService's ONE method this
        // processor's fix needs — QueueService's other 50+ methods and its
        // own dependencies (ProducerQueues, AppRedisService) are unrelated to
        // this finding. The write itself is genuinely real: same jobId
        // scheme as the production `enqueueWhatsappDlq`, same queue.
        {
          provide: QueueService,
          useFactory: (dlq: Queue) => ({
            enqueueWhatsappDlq: (data: WhatsappDlqJob) =>
              dlq.add(JOB.WHATSAPP_DLQ, data, {
                jobId: `dlq-${data.sourceQueue}-${data.originalJobId ?? Date.now()}`,
              }),
          }),
          inject: [getQueueToken(QUEUE.WHATSAPP_DLQ)],
        },
      ],
    }).compile();

    sendQueue = moduleRef.get<Queue>(getQueueToken(QUEUE.WHATSAPP_OUTBOUND));
    dlqQueue = moduleRef.get<Queue>(getQueueToken(QUEUE.WHATSAPP_DLQ));

    const processor = moduleRef.get(WhatsappProcessor);
    const connection = blockingConnectionOptions(moduleRef.get(ConfigService));
    worker = new Worker(
      QUEUE.WHATSAPP_OUTBOUND,
      (job: Job) => processor.process(job as Job<WhatsappSendJob>),
      { connection, prefix: bullPrefix() },
    );
    worker.on('failed', (job, err) => {
      if (job) void processor.onFailed(job, err as Error);
    });
    await worker.waitUntilReady();
  }, 30_000);

  afterAll(async () => {
    await worker.close();
    const outboundJobs = await sendQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 200, false);
    for (const j of outboundJobs) if (String(j.id).includes(SUITE_MARKER)) await j.remove().catch(() => undefined);
    const dlqJobs = await dlqQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 200, false);
    for (const j of dlqJobs) if (JSON.stringify(j.data).includes(SUITE_MARKER)) await j.remove().catch(() => undefined);
    await moduleRef.close();
  }, 30_000);

  beforeEach(() => execution.sendTemplateMessage.mockReset());

  it('[FND-022] BullMQ never retries a provider send failure — the job is marked completed after a single attempt', async () => {
    execution.sendTemplateMessage.mockResolvedValue({
      status: WHATSAPP_DELIVERY_STATUS.FAILED,
      error: `simulated provider failure (${SUITE_MARKER})`,
    });

    const jobId = `${SUITE_MARKER}-retry-check`;
    const data: WhatsappSendJob = {
      tenantId: TENANT_ID,
      templateId: `${SUITE_MARKER}-template`,
      payload: { toWaId: '15550001111' },
    };
    await sendQueue.add(JOB.WHATSAPP_SEND, data, {
      jobId,
      attempts: 3,
      backoff: { type: 'fixed', delay: 50 },
    });

    const state = await waitForTerminal(sendQueue, jobId);
    const job = await sendQueue.getJob(jobId);

    // TODAY: the processor returns the {status: FAILED} result instead of
    // throwing, so BullMQ marks the job `completed` on the FIRST attempt —
    // attemptsMade never climbs, and the provider is asked to send exactly
    // once despite genuinely failing every time.
    expect(state).toBe('failed');
    expect(job?.attemptsMade).toBe(3);
    expect(execution.sendTemplateMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('[FND-022] exhausted retries never reach WHATSAPP_DLQ — the failure is silently discarded', async () => {
    execution.sendTemplateMessage.mockResolvedValue({
      status: WHATSAPP_DELIVERY_STATUS.FAILED,
      error: `simulated provider failure (${SUITE_MARKER})`,
    });

    const jobId = `${SUITE_MARKER}-dlq-check`;
    const data: WhatsappSendJob = {
      tenantId: TENANT_ID,
      templateId: `${SUITE_MARKER}-template`,
      payload: { toWaId: '15550002222' },
    };
    await sendQueue.add(JOB.WHATSAPP_SEND, data, {
      jobId,
      attempts: 2,
      backoff: { type: 'fixed', delay: 50 },
    });

    await waitForTerminal(sendQueue, jobId);
    // Give the (currently nonexistent) DLQ-park logic a moment to run even if
    // it were async/best-effort.
    await new Promise((r) => setTimeout(r, 300));

    const dlqJobs = await dlqQueue.getJobs(['waiting', 'delayed'], 0, 200, false);
    const parked = dlqJobs.find((j) => (j.data as WhatsappDlqJob).originalJobId === jobId);

    // A forced, repeated, genuine provider failure must end up visible and
    // recoverable in the DLQ — today it does not park anywhere at all.
    expect(parked).toBeDefined();
    expect(parked?.data).toMatchObject({
      sourceQueue: QUEUE.WHATSAPP_OUTBOUND,
      tenantId: TENANT_ID,
    });
  }, 15_000);

  // ── Regression guard — a genuine PERMANENT (UnrecoverableError) failure
  // must still short-circuit with no retry, exactly as it does today.
  it('an UnrecoverableError (e.g. worker-authorization rejection) never retries, regardless of the DLQ fix', async () => {
    execution.sendTemplateMessage.mockImplementation(() => {
      throw new UnrecoverableError(`simulated permanent rejection (${SUITE_MARKER})`);
    });

    const jobId = `${SUITE_MARKER}-permanent-check`;
    const data: WhatsappSendJob = {
      tenantId: TENANT_ID,
      templateId: `${SUITE_MARKER}-template`,
      payload: { toWaId: '15550003333' },
    };
    await sendQueue.add(JOB.WHATSAPP_SEND, data, {
      jobId,
      attempts: 5,
      backoff: { type: 'fixed', delay: 50 },
    });

    const state = await waitForTerminal(sendQueue, jobId);
    const job = await sendQueue.getJob(jobId);

    expect(state).toBe('failed');
    expect(job?.attemptsMade).toBe(1); // BullMQ's own UnrecoverableError handling — unchanged by this finding's fix
  }, 15_000);
});
