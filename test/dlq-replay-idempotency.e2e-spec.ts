/**
 * Container-backed replay-idempotency suite for Track B (FND-002, FND-003).
 *
 * TR-003a is explicit: concurrency cannot be certified from mocks. Every
 * existing DLQ test (`whatsapp-dlq.service.spec.ts`, `campaign-dlq.service.spec.ts`)
 * programs a mocked `DistributedLockService` to return a scripted
 * acquire/reject sequence — that proves the SERVICE calls the lock in the
 * right order, not that the LOCK itself is exclusive under a real race. This
 * suite boots the real `AppModule` (via `createE2eApp`, the same bootstrap
 * `webhooks.e2e-spec.ts` uses) against real Postgres (`ziyarati_e2e`) and real
 * Redis (`ziyaratech-redis`), so `DistributedLockService.acquire()` performs
 * an actual `SET NX PX` race and `QueueService` enqueues onto actual BullMQ
 * queues. No worker process runs in this suite (processors live only in
 * `WorkerModule`, never `AppModule` — see the constitution's Queues &
 * Workers principle), so a republished job is safely inspectable afterward
 * without being picked up and sent anywhere real.
 *
 * What stays real vs. what is fault-injected: the lock and the queues are
 * ALWAYS real — that is the property under test. For the two "publish/enqueue
 * fails after a successful claim" cases, `QueueService.publish` /
 * `enqueueCampaignRecipient` is spied for exactly one rejected call
 * (`mockRejectedValueOnce`), because a real, deterministic, repeatable
 * network/Redis failure cannot otherwise be produced on demand — the claim
 * itself is never touched by this spy.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { QueueService } from '../src/queue/queue.service';
import { QUEUE, JOB } from '../src/queue/queue.constants';
import { DistributedLockService } from '../src/queue/distributed-lock.service';
import type { WhatsappDlqJob, CampaignDlqJob } from '../src/queue/job-data.interface';

import { Customer } from '../src/entities/CRM/Customer';
import { Campaign } from '../src/entities/Campaigns/Campaign';
import { CampaignRun } from '../src/entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../src/entities/Campaigns/CampaignRecipient';
import { CampaignType, CampaignExecution, RecipientProcessing } from '../src/entities/enums';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';

const API = '/api/v1';
/** Unique per suite run so cleanup only ever touches jobs THIS file created in the shared dev Redis. */
const SUITE_MARKER = `t043-${randomUUID().slice(0, 8)}`;

async function parkWhatsappJob(e2e: E2eApp, tenantId: string, marker: string): Promise<string> {
  const queueService = e2e.app.get(QueueService);
  const job = await queueService.enqueueWhatsappDlq({
    tenantId,
    sourceQueue: QUEUE.WHATSAPP_WEBHOOK,
    sourceJobName: JOB.WHATSAPP_WEBHOOK_PROCESS,
    originalJobId: `wa-webhook-${marker}`,
    originalData: { webhookEventId: marker, tenantId },
    failedReason: 'e2e-simulated failure (dlq-replay-idempotency suite)',
    attemptsMade: 3,
    diedAt: new Date().toISOString(),
    correlationId: `cid-${marker}`,
  } as WhatsappDlqJob);
  return job.id!;
}

interface CampaignFixture {
  campaign: Campaign;
  run: CampaignRun;
  recipient: CampaignRecipient;
}

/** One FAILED recipient in a COMPLETED run — the exact state a dead-lettered send leaves behind. */
async function seedCampaignFixture(e2e: E2eApp, tenantId: string, marker: string): Promise<CampaignFixture> {
  const customers = e2e.dataSource.getRepository(Customer);
  const campaigns = e2e.dataSource.getRepository(Campaign);
  const runs = e2e.dataSource.getRepository(CampaignRun);
  const recipients = e2e.dataSource.getRepository(CampaignRecipient);

  const customer = await customers.save(
    customers.create({
      tenant: { id: tenantId } as Tenant,
      phone: `+1555${marker.slice(-9)}`,
      email: `${marker}@example.test`,
      full_name: `E2E Recipient ${marker}`,
    }),
  );

  const campaign = await campaigns.save(
    campaigns.create({
      tenant: { id: tenantId } as Tenant,
      type: CampaignType.CUSTOM,
      name: `E2E Campaign ${marker}`,
    }),
  );

  const run = await runs.save(
    runs.create({
      tenant: { id: tenantId } as Tenant,
      campaign: { id: campaign.id } as Campaign,
      execution: CampaignExecution.COMPLETED,
      total_recipients: 1,
      failed: 1,
      queued: 0,
      idempotency_key: randomUUID(),
      finished_at: new Date(),
    }),
  );

  const recipient = await recipients.save(
    recipients.create({
      run: { id: run.id } as CampaignRun,
      campaign: { id: campaign.id } as Campaign,
      customer: { id: customer.id } as Customer,
      processing: RecipientProcessing.FAILED,
    }),
  );

  return { campaign, run, recipient };
}

async function parkCampaignJob(
  e2e: E2eApp,
  tenantId: string,
  fixture: CampaignFixture,
  marker: string,
): Promise<string> {
  const queueService = e2e.app.get(QueueService);
  const job = await queueService.enqueueCampaignDlq({
    tenantId,
    sourceQueue: QUEUE.CAMPAIGNS_PROCESS,
    sourceJobName: JOB.CAMPAIGNS_PROCESS_RECIPIENT,
    originalJobId: `campaign-recipient-${fixture.run.id}-${fixture.recipient.id}`,
    originalData: {
      tenantId,
      campaignId: fixture.campaign.id,
      runId: fixture.run.id,
      recipientId: fixture.recipient.id,
    },
    failedReason: 'e2e-simulated failure (dlq-replay-idempotency suite)',
    attemptsMade: 3,
    diedAt: new Date().toISOString(),
    correlationId: `cid-${marker}`,
  } as CampaignDlqJob);
  return job.id!;
}

/** Best-effort removal of every job this suite created, across all four queues it touches. */
async function sweepQueues(e2e: E2eApp): Promise<void> {
  const queueService = e2e.app.get(QueueService);
  const queues = [QUEUE.WHATSAPP_DLQ, QUEUE.CAMPAIGNS_DLQ, QUEUE.WHATSAPP_WEBHOOK, QUEUE.CAMPAIGNS_PROCESS];
  for (const name of queues) {
    const q = queueService.queue(name);
    const jobs = await q.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 500, false);
    for (const job of jobs) {
      const marker = `${job.id ?? ''}${JSON.stringify(job.data ?? {})}`;
      if (marker.includes(SUITE_MARKER)) {
        await job.remove().catch(() => undefined);
      }
    }
  }
}

describe('DLQ replay idempotency (Track B, container-backed) — real Redis + real Postgres', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'dlq-replay');
  }, 60_000);

  afterAll(async () => {
    await sweepQueues(e2e);
    // Every replay/rejection writes an audit_logs row referencing the owner
    // user (WhatsappDlqService/CampaignDlqService `audit()`), so — same as
    // webhooks.e2e-spec.ts's `cleanupWebhookTenant` — those must go before
    // `cleanupTenant` deletes the user, or the FK on audit_logs blocks it.
    await e2e.dataSource.query(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [owner.tenantId]);
    await cleanupTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 30_000);

  // ── FR-012a: the claim primitive itself, directly against real Redis ─────
  describe('DistributedLockService — real Redis (claim ownership)', () => {
    it('a second acquire on a held key fails until the real holder releases it', async () => {
      const locks = e2e.app.get(DistributedLockService);
      const key = `${SUITE_MARKER}:lock:exclusive`;

      const tokenA = await locks.acquire(key, 5_000);
      expect(tokenA).toEqual(expect.any(String));

      const tokenB = await locks.acquire(key, 5_000);
      expect(tokenB).toBeNull(); // already held — the exclusivity FR-012a depends on

      await locks.release(key, tokenA!);
      const tokenC = await locks.acquire(key, 5_000);
      expect(tokenC).toEqual(expect.any(String)); // free again after the real release
      await locks.release(key, tokenC!);
    });

    it("a caller holding the wrong token cannot release (or steal) another holder's claim", async () => {
      const locks = e2e.app.get(DistributedLockService);
      const key = `${SUITE_MARKER}:lock:ownership`;

      const realToken = await locks.acquire(key, 5_000);
      expect(realToken).toEqual(expect.any(String));

      // A request that lost the race must not be able to release the winner's
      // lock by guessing/forging a token — this is what makes the Lua
      // compare-and-delete meaningful rather than a plain DEL.
      await locks.release(key, `forged-${randomUUID()}`);

      const stillHeld = await locks.acquire(key, 5_000);
      expect(stillHeld).toBeNull(); // the forged release was a no-op

      await locks.release(key, realToken!); // the real owner still can release it
      const freedNow = await locks.acquire(key, 5_000);
      expect(freedNow).toEqual(expect.any(String));
      await locks.release(key, freedNow!);
    });

    it('a held claim becomes claimable again once its TTL expires (holder-dies recovery path)', async () => {
      const locks = e2e.app.get(DistributedLockService);
      const key = `${SUITE_MARKER}:lock:ttl`;

      const token = await locks.acquire(key, 300);
      expect(token).toEqual(expect.any(String));
      await new Promise((r) => setTimeout(r, 500));

      const afterExpiry = await locks.acquire(key, 5_000);
      expect(afterExpiry).toEqual(expect.any(String)); // reclaimed without ever being explicitly released
      await locks.release(key, afterExpiry!);
    });
  });

  // ── FND-002 / FR-012: WhatsApp replay mints a non-deterministic job id ───
  // (by design — see research R5), so the claim is the ONLY protection
  // against a duplicate send.
  describe('WhatsApp DLQ replay concurrency (real Redis + real BullMQ)', () => {
    it('two concurrent replay requests for one parked job: exactly one claims, exactly one publish', async () => {
      const marker = `${SUITE_MARKER}-wa-race-${randomUUID().slice(0, 8)}`;
      const jobId = await parkWhatsappJob(e2e, owner.tenantId, marker);

      const [r1, r2] = await Promise.all([
        request(e2e.app.getHttpServer())
          .post(`${API}/admin/whatsapp/dlq/${jobId}/replay`)
          .set(...authHeader(owner.token))
          .send(),
        request(e2e.app.getHttpServer())
          .post(`${API}/admin/whatsapp/dlq/${jobId}/replay`)
          .set(...authHeader(owner.token))
          .send(),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 404]); // one claims, one is rejected — never both, never neither (NestJS default POST status is 201)

      const winner = r1.status === 201 ? r1 : r2;
      expect(winner.body).toEqual({ replayed: true, jobId });

      const queueService = e2e.app.get(QueueService);
      const stillParked = await queueService.queue(QUEUE.WHATSAPP_DLQ).getJob(jobId);
      expect(stillParked).toBeUndefined(); // removed exactly once, by the winner, after publish

      // Exactly one republish reached the source queue — proven by data, not
      // by job id, since WhatsApp deliberately mints a non-deterministic id.
      const republished = await queueService
        .queue(QUEUE.WHATSAPP_WEBHOOK)
        .getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 500, false);
      const matches = republished.filter((j) => (j.data as { webhookEventId?: string }).webhookEventId === marker);
      expect(matches).toHaveLength(1); // SC-005: at most one publish, proven, not assumed
    });

    it('repeated replay after a successful replay is rejected — no second publish', async () => {
      const marker = `${SUITE_MARKER}-wa-repeat-${randomUUID().slice(0, 8)}`;
      const jobId = await parkWhatsappJob(e2e, owner.tenantId, marker);

      const first = await request(e2e.app.getHttpServer())
        .post(`${API}/admin/whatsapp/dlq/${jobId}/replay`)
        .set(...authHeader(owner.token))
        .send();
      expect(first.status).toBe(201); // NestJS default POST status

      const second = await request(e2e.app.getHttpServer())
        .post(`${API}/admin/whatsapp/dlq/${jobId}/replay`)
        .set(...authHeader(owner.token))
        .send();
      expect(second.status).toBe(404); // the entry the second call looked for no longer exists

      const queueService = e2e.app.get(QueueService);
      const republished = await queueService
        .queue(QUEUE.WHATSAPP_WEBHOOK)
        .getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 500, false);
      const matches = republished.filter((j) => (j.data as { webhookEventId?: string }).webhookEventId === marker);
      expect(matches).toHaveLength(1); // still one — the rejected retry never published
    });

    it('a publish failure after a successful claim retains the parked entry and releases the lock; the job is then safely retried', async () => {
      const marker = `${SUITE_MARKER}-wa-recover-${randomUUID().slice(0, 8)}`;
      const jobId = await parkWhatsappJob(e2e, owner.tenantId, marker);
      const queueService = e2e.app.get(QueueService);

      const publishSpy = jest
        .spyOn(queueService, 'publish')
        .mockRejectedValueOnce(new Error('e2e-simulated publish failure'));

      const failed = await request(e2e.app.getHttpServer())
        .post(`${API}/admin/whatsapp/dlq/${jobId}/replay`)
        .set(...authHeader(owner.token))
        .send();
      expect(failed.status).toBe(500); // an unhandled Error, not a modelled AppError — AllExceptionsFilter's fallback

      const stillParked = await queueService.queue(QUEUE.WHATSAPP_DLQ).getJob(jobId);
      expect(stillParked).toBeTruthy(); // never lost

      // Never permanently unclaimable: the lock was released, so a genuine
      // retry (the mocked-once spy now falls through to the real publish)
      // succeeds immediately — this proves recovery end-to-end, not just
      // that `release()` was called.
      const retried = await request(e2e.app.getHttpServer())
        .post(`${API}/admin/whatsapp/dlq/${jobId}/replay`)
        .set(...authHeader(owner.token))
        .send();
      expect(retried.status).toBe(201); // NestJS default POST status
      expect(retried.body).toEqual({ replayed: true, jobId });

      const republished = await queueService
        .queue(QUEUE.WHATSAPP_WEBHOOK)
        .getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'], 0, 500, false);
      const matches = republished.filter((j) => (j.data as { webhookEventId?: string }).webhookEventId === marker);
      expect(matches).toHaveLength(1); // the failed attempt never published — only the retry did

      publishSpy.mockRestore();
    });
  });

  // ── FND-003 / FR-012: Campaign replay has a SECOND layer (deterministic ──
  // job id + affected-rows-guarded counters) behind the claim — verify both.
  describe('Campaign DLQ replay concurrency (real Redis + real Postgres, deterministic job id)', () => {
    it('ten concurrent replay requests for one parked job: exactly one claims; counters move by exactly one, not ten', async () => {
      const marker = `${SUITE_MARKER}-camp-race-${randomUUID().slice(0, 8)}`;
      const fixture = await seedCampaignFixture(e2e, owner.tenantId, marker);
      const jobId = await parkCampaignJob(e2e, owner.tenantId, fixture, marker);

      const attempts = Array.from({ length: 10 }, () =>
        request(e2e.app.getHttpServer())
          .post(`${API}/admin/campaigns/dlq/${jobId}/replay`)
          .set(...authHeader(owner.token))
          .send(),
      );
      const results = await Promise.all(attempts);

      const succeeded = results.filter((r) => r.status === 201); // NestJS default POST status
      const rejected = results.filter((r) => r.status === 404);
      expect(succeeded).toHaveLength(1); // exactly one claim wins, out of ten concurrent attempts
      expect(rejected).toHaveLength(9);

      const runs = e2e.dataSource.getRepository(CampaignRun);
      const refreshedRun = await runs.findOneOrFail({ where: { id: fixture.run.id } });
      expect(refreshedRun.failed).toBe(0); // 1 → 0, moved once — not ten times
      expect(refreshedRun.queued).toBe(1); // 0 → 1

      const recipients = e2e.dataSource.getRepository(CampaignRecipient);
      const refreshedRecipient = await recipients.findOneOrFail({ where: { id: fixture.recipient.id } });
      expect(refreshedRecipient.processing).toBe(RecipientProcessing.PENDING); // not double-transitioned

      // Deterministic job id: BullMQ itself would also collapse a duplicate
      // enqueue onto this one job — a second, independent layer behind the claim.
      const queueService = e2e.app.get(QueueService);
      const recipientJob = await queueService
        .queue(QUEUE.CAMPAIGNS_PROCESS)
        .getJob(`campaign-recipient-${fixture.run.id}-${fixture.recipient.id}`);
      expect(recipientJob).toBeTruthy();
    });

    it('an enqueue failure after a successful claim retains the parked entry and does not double-adjust counters on retry', async () => {
      const marker = `${SUITE_MARKER}-camp-recover-${randomUUID().slice(0, 8)}`;
      const fixture = await seedCampaignFixture(e2e, owner.tenantId, marker);
      const jobId = await parkCampaignJob(e2e, owner.tenantId, fixture, marker);
      const queueService = e2e.app.get(QueueService);

      const enqueueSpy = jest
        .spyOn(queueService, 'enqueueCampaignRecipient')
        .mockRejectedValueOnce(new Error('e2e-simulated enqueue failure'));

      const failed = await request(e2e.app.getHttpServer())
        .post(`${API}/admin/campaigns/dlq/${jobId}/replay`)
        .set(...authHeader(owner.token))
        .send();
      expect(failed.status).toBe(500);

      const stillParked = await queueService.queue(QUEUE.CAMPAIGNS_DLQ).getJob(jobId);
      expect(stillParked).toBeTruthy(); // never lost

      const runs = e2e.dataSource.getRepository(CampaignRun);
      const recipients = e2e.dataSource.getRepository(CampaignRecipient);

      // The counter-reconciliation transaction commits BEFORE the enqueue
      // call, so it already moved even though the enqueue right after it
      // failed — this is the exact ordering the affected-rows guard exists
      // to make safe on retry (see campaign-dlq.service.ts `doReplay`).
      const afterFailure = await runs.findOneOrFail({ where: { id: fixture.run.id } });
      expect(afterFailure.failed).toBe(0);
      expect(afterFailure.queued).toBe(1);

      const retried = await request(e2e.app.getHttpServer())
        .post(`${API}/admin/campaigns/dlq/${jobId}/replay`)
        .set(...authHeader(owner.token))
        .send();
      expect(retried.status).toBe(201); // recovered: retryable, not permanently stuck (NestJS default POST status)

      // The retry's reconciliation UPDATE targets `processing = FAILED`,
      // which no longer matches (already PENDING from the first attempt) —
      // the affected-rows guard makes it a safe no-op rather than a double count.
      const afterRetry = await runs.findOneOrFail({ where: { id: fixture.run.id } });
      expect(afterRetry.failed).toBe(0);
      expect(afterRetry.queued).toBe(1); // unchanged — NOT 2

      const refreshedRecipient = await recipients.findOneOrFail({ where: { id: fixture.recipient.id } });
      expect(refreshedRecipient.processing).toBe(RecipientProcessing.PENDING);

      const recipientJob = await queueService
        .queue(QUEUE.CAMPAIGNS_PROCESS)
        .getJob(`campaign-recipient-${fixture.run.id}-${fixture.recipient.id}`);
      expect(recipientJob).toBeTruthy(); // exactly one — enqueued only by the successful retry

      enqueueSpy.mockRestore();
    });
  });
});
