import { Injectable, Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignExecution, RecipientProcessing } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { QueueService } from '../../queue/queue.service';
import { QUEUE } from '../../queue/queue.constants';
import { CampaignDlqJob, CampaignProcessRecipientJob } from '../../queue/job-data.interface';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';

/** Ceiling on how many parked jobs we scan to fill one tenant-scoped page. */
const OVERFETCH_FACTOR = 5;
/** Absolute scan ceiling — never an unbounded queue walk (SR-006, FR-010). */
const OVERFETCH_HARD_CAP = 1000;
/** Replay claim lifetime. Comfortably above observed publish latency. */
const REPLAY_LOCK_TTL_MS = 30_000;

/**
 * Dead-Letter Queue admin operations. The DLQ is never auto-processed; these
 * methods back the admin endpoints for inspecting and replaying parked jobs.
 *
 * TENANT ISOLATION (FND-003). Mirrors `WhatsappDlqService`: every read and
 * mutation is confined to the caller's authenticated tenant, ownership comes
 * from the parked job and is compared against `requireTenantId()`, and a foreign
 * or unowned job raises exactly the NOT_FOUND a missing job raises. There is
 * deliberately NO super-admin bypass (DEF-001 defers the operator path).
 *
 * REPLAY IDEMPOTENCY (FR-012). The parked entry is claimed with a distributed
 * lock before republishing. The counter reconciliation below was already
 * idempotent on its own (affected-rows guarded) and is left exactly as it was;
 * the claim additionally prevents two concurrent replays from both running it.
 */
@Injectable()
export class CampaignDlqService {
  private readonly logger = new Logger('CampaignDlqService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly queue: QueueService,
    private readonly tenantContext: TenantContextService,
    private readonly locks: DistributedLockService,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  /** Current DLQ depth (waiting + delayed). A count only — no tenant-owned data. */
  depth(): Promise<number> {
    return this.queue.dlqDepth();
  }

  /**
   * List parked DLQ jobs owned by the caller's tenant (newest first).
   *
   * Bounded, over-fetched scan filtered by owner, so a page is not short merely
   * because another tenant's jobs are newer. No extra Redis round-trip and no
   * per-item database query (PR-003).
   */
  async list(limit = 100) {
    const tenantId = this.tenantContext.requireTenantId();
    const pageSize = Math.max(0, limit);
    const scanTo = Math.min(pageSize * OVERFETCH_FACTOR, OVERFETCH_HARD_CAP);

    const dlq = this.queue.queue(QUEUE.CAMPAIGNS_DLQ);
    const jobs = await dlq.getJobs(['waiting', 'delayed'], 0, Math.max(0, scanTo - 1), false);

    const owned: ReturnType<typeof this.toSummary>[] = [];
    for (const job of jobs) {
      if (owned.length >= pageSize) break;
      const data = job.data as CampaignDlqJob;
      if (!this.ownsJob(data, tenantId)) continue;
      owned.push(this.toSummary(job.id, data));
    }
    return owned;
  }

  /**
   * Replay a parked job back onto its source queue with a fresh attempt budget.
   *
   * Because the dead-letter reconcile counted the recipient as FAILED (so the run
   * could complete), replay must REVERSE that accounting in the same transaction:
   * reset the recipient to PENDING, give back one `failed`→`queued`, and reopen a
   * COMPLETED run to PROCESSING so the re-enqueued send can actually run and the
   * run can re-complete. All guarded by affected-rows so a double replay is a no-op.
   */
  async replay(jobId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const dlq = this.queue.queue(QUEUE.CAMPAIGNS_DLQ);
    const job = await dlq.getJob(jobId);

    // Ownership re-resolved at action time, never carried from a prior listing.
    const data = job?.data as CampaignDlqJob | undefined;
    if (!job || !data || !this.ownsJob(data, tenantId)) {
      await this.audit('campaigns.dlq.replay', jobId, 'rejected', undefined);
      throw this.notFound();
    }

    if (data.sourceQueue !== QUEUE.CAMPAIGNS_PROCESS) {
      await this.audit('campaigns.dlq.replay', jobId, 'unsupported_source', data.correlationId);
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Replay not supported for source queue "${data.sourceQueue}"`,
      });
    }

    // Claim BEFORE the counter transaction and the republish, so two concurrent
    // replays cannot both reconcile counters or both enqueue.
    const lockKey = `dlq:replay:${QUEUE.CAMPAIGNS_DLQ}:${jobId}`;
    const token = await this.locks.acquire(lockKey, REPLAY_LOCK_TTL_MS);
    if (!token) {
      await this.audit('campaigns.dlq.replay', jobId, 'already_in_flight', data.correlationId);
      throw this.notFound();
    }

    try {
      return await this.doReplay(job, data, jobId);
    } catch (err) {
      // Leave the parked entry in place so the job is never lost, and release the
      // claim so it is retryable immediately rather than waiting out the TTL.
      await this.audit('campaigns.dlq.replay', jobId, 'failed', data.correlationId);
      throw err;
    } finally {
      await this.locks.release(lockKey, token).catch(() => undefined);
    }
  }

  /** The original replay body, unchanged apart from being claim-protected. */
  private async doReplay(
    job: { remove: () => Promise<unknown> },
    data: CampaignDlqJob,
    jobId: string,
  ) {
    const orig = data.originalData as unknown as CampaignProcessRecipientJob;
    await this.dataSource.transaction(async (mgr) => {
      const res = await mgr.update(
        CampaignRecipient,
        { id: orig.recipientId, processing: RecipientProcessing.FAILED },
        { processing: RecipientProcessing.PENDING, failure_class: null, failure_reason: null },
      );
      if ((res.affected ?? 0) > 0) {
        // Give the slot back to the run's queue.
        await mgr
          .createQueryBuilder()
          .update(CampaignRun)
          .set({ failed: () => 'GREATEST(failed - 1, 0)', queued: () => 'queued + 1' })
          .where('id = :runId', { runId: orig.runId })
          .execute();
        // Reopen a finished run so the replayed send can proceed.
        await mgr
          .createQueryBuilder()
          .update(CampaignRun)
          .set({ execution: CampaignExecution.PROCESSING, finished_at: () => 'NULL' })
          .where('id = :runId', { runId: orig.runId })
          .andWhere('execution = :done', { done: CampaignExecution.COMPLETED })
          .execute();
      }
    });

    await this.queue.enqueueCampaignRecipient({
      tenantId: orig.tenantId,
      campaignId: orig.campaignId,
      runId: orig.runId,
      recipientId: orig.recipientId,
      correlationId: data.correlationId,
    });

    // Remove only after a confirmed enqueue. Removal failure is surfaced, not
    // swallowed: with the claim held, a retained entry is safe to replay again,
    // whereas silently dropping it on an unconfirmed publish would lose the job.
    await job.remove();
    await this.audit('campaigns.dlq.replay', jobId, 'replayed', data.correlationId);
    this.logger.log(`Replayed DLQ job ${jobId} → ${data.sourceQueue}`);
    return { replayed: true, jobId };
  }

  /** Discard a parked job without replaying. */
  async discard(jobId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const dlq = this.queue.queue(QUEUE.CAMPAIGNS_DLQ);
    const job = await dlq.getJob(jobId);

    const data = job?.data as CampaignDlqJob | undefined;
    if (!job || !data || !this.ownsJob(data, tenantId)) {
      await this.audit('campaigns.dlq.discard', jobId, 'rejected', undefined);
      throw this.notFound();
    }

    await job.remove();
    await this.audit('campaigns.dlq.discard', jobId, 'discarded', data.correlationId);
    return { discarded: true, jobId };
  }

  // ──────────────────────────────── Internals ────────────────────────────────

  /**
   * True only when the parked job records the caller's tenant. A job with no
   * recorded owner is treated as NOT owned — fail closed, never visible to all.
   */
  private ownsJob(data: CampaignDlqJob | undefined, tenantId: string): boolean {
    return Boolean(data?.tenantId) && data?.tenantId === tenantId;
  }

  /**
   * Operational fields only. `originalData` is deliberately NOT returned — it
   * carries recipient-identifying campaign payload (SR-005). `tenantId` is
   * omitted because it is necessarily the caller's own tenant.
   */
  private toSummary(jobId: string | undefined, d: CampaignDlqJob) {
    return {
      jobId,
      sourceQueue: d.sourceQueue,
      sourceJobName: d.sourceJobName,
      failedReason: d.failedReason,
      attemptsMade: d.attemptsMade,
      diedAt: d.diedAt,
      correlationId: d.correlationId,
    };
  }

  /** The single rejection for missing AND foreign jobs — no existence oracle. */
  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, { message: 'DLQ job not found' });
  }

  /**
   * Safe audit record (FR-013). Identifiers and outcome only — never payload
   * content or PII (SR-010, OB-005). The job id goes in the jsonb detail, not
   * `entity_id`, which is a uuid column while BullMQ ids are not uuids.
   */
  private async audit(
    action: string,
    jobId: string,
    result: string,
    correlationId: string | undefined,
  ): Promise<void> {
    try {
      const tenantId = this.tenantContext.getTenantId();
      const userId = this.tenantContext.getUser()?.id;
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: tenantId ? ({ id: tenantId } as Tenant) : undefined,
          user: userId ? ({ id: userId } as User) : undefined,
          action,
          entity_type: 'campaign_dlq_job',
          new_values: {
            jobId,
            result,
            correlationId: correlationId ?? this.tenantContext.getCorrelationId() ?? null,
          },
        }),
      );
    } catch (err) {
      // Auditing must never mask or block the security decision it records.
      this.logger.warn(`DLQ audit write failed: ${(err as Error).message}`);
    }
  }
}
