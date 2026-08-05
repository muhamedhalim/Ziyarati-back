/**
 * FND-038 — real-Redis/BullMQ suite proving exhausted-retry failures reach
 * their named DLQ for all three processors named in scope: WHATSAPP_OUTBOUND,
 * CAMPAIGNS_LAUNCH, CAMPAIGNS_FANOUT.
 *
 * WHATSAPP_OUTBOUND is already fixed (Wave 2, FND-022/T038 — see the full,
 * deeper suite at `test/whatsapp-dlq.e2e-spec.ts`); it is included here only
 * as a one-case regression guard so this file is self-contained for every
 * queue T110 names, without duplicating that suite's depth.
 *
 * CAMPAIGNS_LAUNCH and CAMPAIGNS_FANOUT are the genuine gap: `CampaignLaunchProcessor`
 * and `CampaignFanoutProcessor` (`src/worker/processors/campaigns.processor.ts`)
 * both have an `onFailed` handler that only logs — neither enqueues onto
 * `CAMPAIGNS_DLQ` — so an exhausted, genuinely-failing job vanishes with no
 * trace, unlike `CampaignDispatchProcessor` (the third class in the same file,
 * CAMPAIGNS_PROCESS queue), which already reconciles + dead-letters correctly
 * (Wave 3, FND-020).
 *
 * WHAT IS REAL vs STUBBED (same principle as `whatsapp-dlq.e2e-spec.ts`):
 * `WhatsappExecutionService` and `CampaignFanoutService` are stubbed to force a
 * deterministic failure — job scheduling, BullMQ's real attempts/backoff retry
 * engine, and the DLQ park all run against REAL Redis via a REAL BullMQ
 * `Queue` + `Worker`, using the SAME processor classes the worker process
 * registers in production.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue, Worker, Job } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { WhatsappProcessor } from '../src/worker/processors/whatsapp.processor';
import { CampaignLaunchProcessor, CampaignFanoutProcessor } from '../src/worker/processors/campaigns.processor';
import { WhatsappExecutionService } from '../src/modules/whatsapp/whatsapp-execution.service';
import { CampaignFanoutService } from '../src/modules/campaigns/campaign-fanout.service';
import { TenantContextService } from '../src/core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../src/queue/worker-authorization.service';
import { QueueService } from '../src/queue/queue.service';
import { QUEUE, JOB, bullPrefix } from '../src/queue/queue.constants';
import { blockingConnectionOptions } from '../src/queue/redis.config';
import type {
  WhatsappSendJob, WhatsappDlqJob, CampaignLaunchJob, CampaignFanoutChunkJob, CampaignDlqJob,
} from '../src/queue/job-data.interface';
import { WHATSAPP_DELIVERY_STATUS } from '../src/modules/whatsapp/whatsapp.constants';

const SUITE_MARKER = `t110-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `${SUITE_MARKER}-tenant`;

/** Polls until the job leaves the active/waiting/delayed states, or times out. */
async function waitForTerminal(queue: Queue, jobId: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await queue.getJob(jobId);
    if (!job) return 'missing';
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') return state;
    if (Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Processor DLQ routing — WHATSAPP_OUTBOUND, CAMPAIGNS_LAUNCH, CAMPAIGNS_FANOUT (FND-038, real Redis + real BullMQ)', () => {
  let moduleRef: TestingModule;
  let waSendQueue: Queue;
  let waDlqQueue: Queue;
  let launchQueue: Queue;
  let fanoutQueue: Queue;
  let campaignsDlqQueue: Queue;
  let execution: { sendTemplateMessage: jest.Mock };
  let fanout: { handleLaunch: jest.Mock; handleChunk: jest.Mock };
  let waWorker: Worker;
  let launchWorker: Worker;
  let fanoutWorker: Worker;

  beforeAll(async () => {
    execution = { sendTemplateMessage: jest.fn() };
    fanout = { handleLaunch: jest.fn(), handleChunk: jest.fn() };
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
          { name: QUEUE.CAMPAIGNS_LAUNCH },
          { name: QUEUE.CAMPAIGNS_FANOUT },
          { name: QUEUE.CAMPAIGNS_DLQ },
        ),
      ],
      providers: [
        WhatsappProcessor,
        CampaignLaunchProcessor,
        CampaignFanoutProcessor,
        { provide: WhatsappExecutionService, useValue: execution },
        { provide: CampaignFanoutService, useValue: fanout },
        TenantContextService,
        { provide: WorkerAuthorizationService, useValue: authz },
        // Real-Redis-backed stand-ins for the two DLQ-enqueue methods these
        // processors need — same technique as whatsapp-dlq.e2e-spec.ts.
        {
          provide: QueueService,
          useFactory: (waDlq: Queue, campaignsDlq: Queue) => ({
            enqueueWhatsappDlq: (data: WhatsappDlqJob) =>
              waDlq.add(JOB.WHATSAPP_DLQ, data, {
                jobId: `dlq-${data.sourceQueue}-${data.originalJobId ?? Date.now()}`,
              }),
            enqueueCampaignDlq: (data: CampaignDlqJob) =>
              campaignsDlq.add(JOB.CAMPAIGNS_DLQ, data, {
                jobId: `dlq-${data.sourceQueue}-${data.originalJobId ?? Date.now()}`,
              }),
          }),
          inject: [getQueueToken(QUEUE.WHATSAPP_DLQ), getQueueToken(QUEUE.CAMPAIGNS_DLQ)],
        },
      ],
    }).compile();

    waSendQueue = moduleRef.get<Queue>(getQueueToken(QUEUE.WHATSAPP_OUTBOUND));
    waDlqQueue = moduleRef.get<Queue>(getQueueToken(QUEUE.WHATSAPP_DLQ));
    launchQueue = moduleRef.get<Queue>(getQueueToken(QUEUE.CAMPAIGNS_LAUNCH));
    fanoutQueue = moduleRef.get<Queue>(getQueueToken(QUEUE.CAMPAIGNS_FANOUT));
    campaignsDlqQueue = moduleRef.get<Queue>(getQueueToken(QUEUE.CAMPAIGNS_DLQ));

    const connection = blockingConnectionOptions(moduleRef.get(ConfigService));

    const waProcessor = moduleRef.get(WhatsappProcessor);
    waWorker = new Worker(QUEUE.WHATSAPP_OUTBOUND, (job: Job) => waProcessor.process(job as Job<WhatsappSendJob>), { connection, prefix: bullPrefix() });
    waWorker.on('failed', (job, err) => { if (job) void waProcessor.onFailed(job, err as Error); });

    const launchProcessor = moduleRef.get(CampaignLaunchProcessor);
    launchWorker = new Worker(QUEUE.CAMPAIGNS_LAUNCH, (job: Job) => launchProcessor.process(job), { connection, prefix: bullPrefix() });
    launchWorker.on('failed', (job, err) => { if (job) launchProcessor.onFailed(job, err as Error); });

    const fanoutProcessor = moduleRef.get(CampaignFanoutProcessor);
    fanoutWorker = new Worker(QUEUE.CAMPAIGNS_FANOUT, (job: Job) => fanoutProcessor.process(job), { connection, prefix: bullPrefix() });
    fanoutWorker.on('failed', (job, err) => { if (job) fanoutProcessor.onFailed(job, err as Error); });

    await Promise.all([waWorker.waitUntilReady(), launchWorker.waitUntilReady(), fanoutWorker.waitUntilReady()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([waWorker.close(), launchWorker.close(), fanoutWorker.close()]);
    for (const q of [waSendQueue, launchQueue, fanoutQueue]) {
      const jobs = await q.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 200, false);
      for (const j of jobs) if (String(j.id).includes(SUITE_MARKER)) await j.remove().catch(() => undefined);
    }
    for (const q of [waDlqQueue, campaignsDlqQueue]) {
      const jobs = await q.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 200, false);
      for (const j of jobs) if (JSON.stringify(j.data).includes(SUITE_MARKER)) await j.remove().catch(() => undefined);
    }
    await moduleRef.close();
  }, 30_000);

  beforeEach(() => {
    execution.sendTemplateMessage.mockReset();
    fanout.handleLaunch.mockReset();
    fanout.handleChunk.mockReset();
  });

  // ── Regression guard (Wave 2, FND-022 — already fixed; full depth in whatsapp-dlq.e2e-spec.ts) ──
  it('[regression guard] WHATSAPP_OUTBOUND: exhausted retries reach WHATSAPP_DLQ', async () => {
    execution.sendTemplateMessage.mockResolvedValue({
      status: WHATSAPP_DELIVERY_STATUS.FAILED,
      error: `simulated provider failure (${SUITE_MARKER})`,
    });
    const jobId = `${SUITE_MARKER}-wa-dlq-check`;
    const data: WhatsappSendJob = { tenantId: TENANT_ID, templateId: `${SUITE_MARKER}-template`, payload: { toWaId: '15550009999' } };
    await waSendQueue.add(JOB.WHATSAPP_SEND, data, { jobId, attempts: 2, backoff: { type: 'fixed', delay: 50 } });

    await waitForTerminal(waSendQueue, jobId);
    await new Promise((r) => setTimeout(r, 300));

    const dlqJobs = await waDlqQueue.getJobs(['waiting', 'delayed'], 0, 200, false);
    const parked = dlqJobs.find((j) => (j.data as WhatsappDlqJob).originalJobId === jobId);
    expect(parked).toBeDefined();
  }, 15_000);

  // ── FND-038 gap — CAMPAIGNS_LAUNCH ──
  it('[FND-038] CAMPAIGNS_LAUNCH: exhausted retries never reach CAMPAIGNS_DLQ today', async () => {
    fanout.handleLaunch.mockRejectedValue(new Error(`simulated launch failure (${SUITE_MARKER})`));

    const jobId = `${SUITE_MARKER}-launch-dlq-check`;
    const data: CampaignLaunchJob = {
      tenantId: TENANT_ID, campaignId: `${SUITE_MARKER}-campaign`, runId: `${SUITE_MARKER}-run-launch`, idempotencyKey: `${SUITE_MARKER}-idem`,
    };
    await launchQueue.add(JOB.CAMPAIGNS_LAUNCH, data, { jobId, attempts: 2, backoff: { type: 'fixed', delay: 50 } });

    const state = await waitForTerminal(launchQueue, jobId);
    await new Promise((r) => setTimeout(r, 300));

    expect(state).toBe('failed');
    expect(fanout.handleLaunch.mock.calls.length).toBeGreaterThanOrEqual(2); // BullMQ DID retry — that part already worked

    const dlqJobs = await campaignsDlqQueue.getJobs(['waiting', 'delayed'], 0, 200, false);
    const parked = dlqJobs.find((j) => (j.data as CampaignDlqJob).originalJobId === jobId);
    // A forced, repeated, genuine failure must end up visible and recoverable
    // in the DLQ — today it does not park anywhere at all (onFailed only logs).
    expect(parked).toBeDefined();
    expect(parked?.data).toMatchObject({ sourceQueue: QUEUE.CAMPAIGNS_LAUNCH, tenantId: TENANT_ID });
  }, 15_000);

  // ── FND-038 gap — CAMPAIGNS_FANOUT ──
  it('[FND-038] CAMPAIGNS_FANOUT: exhausted retries never reach CAMPAIGNS_DLQ today', async () => {
    fanout.handleChunk.mockRejectedValue(new Error(`simulated fanout failure (${SUITE_MARKER})`));

    const jobId = `${SUITE_MARKER}-fanout-dlq-check`;
    const data: CampaignFanoutChunkJob = {
      tenantId: TENANT_ID, campaignId: `${SUITE_MARKER}-campaign`, runId: `${SUITE_MARKER}-run-fanout`, cursor: null,
    };
    await fanoutQueue.add(JOB.CAMPAIGNS_FANOUT_CHUNK, data, { jobId, attempts: 2, backoff: { type: 'fixed', delay: 50 } });

    const state = await waitForTerminal(fanoutQueue, jobId);
    await new Promise((r) => setTimeout(r, 300));

    expect(state).toBe('failed');
    expect(fanout.handleChunk.mock.calls.length).toBeGreaterThanOrEqual(2);

    const dlqJobs = await campaignsDlqQueue.getJobs(['waiting', 'delayed'], 0, 200, false);
    const parked = dlqJobs.find((j) => (j.data as CampaignDlqJob).originalJobId === jobId);
    expect(parked).toBeDefined();
    expect(parked?.data).toMatchObject({ sourceQueue: QUEUE.CAMPAIGNS_FANOUT, tenantId: TENANT_ID });
  }, 15_000);
});
