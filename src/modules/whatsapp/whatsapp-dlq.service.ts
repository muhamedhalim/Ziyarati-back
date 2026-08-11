import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { QueueService } from '../../queue/queue.service';
import { QUEUE, QueueName } from '../../queue/queue.constants';
import { BaseJobData, WhatsappDlqJob } from '../../queue/job-data.interface';
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
 * Dead-letter queue admin operations for the inbound `whatsapp-webhook` and
 * `whatsapp-media` queues (mirrors `CampaignDlqService`).
 *
 * TENANT ISOLATION (FND-002). Every read and mutation is confined to the
 * caller's authenticated tenant. The owning tenant is taken from the parked job
 * and compared against `TenantContextService.requireTenantId()` — it is never
 * accepted from the caller. A foreign or unowned job raises exactly the same
 * NOT_FOUND a genuinely missing job raises, so this endpoint is not an existence
 * oracle. There is deliberately NO super-admin bypass: the platform-operator
 * path is deferred (DEF-001), so any cross-tenant code path here is a defect.
 *
 * REPLAY IDEMPOTENCY (FR-012). The parked entry is claimed with a distributed
 * lock BEFORE it is republished, so concurrent replays cannot both publish. This
 * matters more here than for campaigns: WhatsApp replay deliberately mints a
 * fresh job id (see `replay`) to defeat the source queue's deterministic id, so
 * the claim is the ONLY thing preventing a duplicate send.
 */
@Injectable()
export class WhatsappDlqService {
  private readonly logger = new Logger('WhatsappDlqService');

  constructor(
    private readonly queue: QueueService,
    private readonly tenantContext: TenantContextService,
    private readonly locks: DistributedLockService,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  /**
   * Current DLQ depth — the count of the CALLER'S OWN parked jobs (waiting +
   * delayed), not the platform-wide figure `queue.dlqDepth()` used to return
   * behind this tenant-level permission (ZT-009). Reuses `list()`'s own
   * bounded, owner-filtered scan rather than a second scanning strategy;
   * since depth has no caller-supplied page size to derive a smaller bound
   * from, it scans straight to `OVERFETCH_HARD_CAP` — the same ceiling
   * `list()` converges on for any sufficiently large `limit`.
   */
  async depth(): Promise<number> {
    const tenantId = this.tenantContext.requireTenantId();
    const dlq = this.queue.queue(QUEUE.WHATSAPP_DLQ);
    const jobs = await dlq.getJobs(
      ['waiting', 'delayed'],
      0,
      OVERFETCH_HARD_CAP - 1,
      false,
    );

    let count = 0;
    for (const job of jobs) {
      if (this.ownsJob(job.data as WhatsappDlqJob, tenantId)) count++;
    }
    return count;
  }

  /**
   * List parked DLQ jobs owned by the caller's tenant (newest first).
   *
   * Scans a bounded, over-fetched window and filters by owner, so a page is not
   * short merely because other tenants' jobs happen to be newer. Ownership is
   * decided from data the window already returned — no extra Redis round-trip
   * and no per-item database query (PR-003).
   */
  async list(limit = 100) {
    const tenantId = this.tenantContext.requireTenantId();
    const pageSize = Math.max(0, limit);
    const scanTo = Math.min(pageSize * OVERFETCH_FACTOR, OVERFETCH_HARD_CAP);

    const dlq = this.queue.queue(QUEUE.WHATSAPP_DLQ);
    const jobs = await dlq.getJobs(
      ['waiting', 'delayed'],
      0,
      Math.max(0, scanTo - 1),
      false,
    );

    const owned: ReturnType<typeof this.toSummary>[] = [];
    for (const job of jobs) {
      if (owned.length >= pageSize) break;
      const data = job.data as WhatsappDlqJob;
      if (!this.ownsJob(data, tenantId)) continue;
      owned.push(this.toSummary(job.id, data));
    }
    return owned;
  }

  /** Replay a parked job back onto its source queue with a fresh attempt budget. */
  async replay(jobId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const dlq = this.queue.queue(QUEUE.WHATSAPP_DLQ);
    const job = await dlq.getJob(jobId);

    // Ownership is re-resolved here, at action time — never carried over from a
    // prior listing (FR-007a, FR-011).
    const data = job?.data as WhatsappDlqJob | undefined;
    if (!job || !data || !this.ownsJob(data, tenantId)) {
      await this.audit('whatsapp.dlq.replay', jobId, 'rejected', undefined);
      throw this.notFound();
    }

    const sourceQueue = data.sourceQueue as QueueName;
    if (
      sourceQueue !== QUEUE.WHATSAPP_WEBHOOK &&
      sourceQueue !== QUEUE.WHATSAPP_MEDIA
    ) {
      await this.audit(
        'whatsapp.dlq.replay',
        jobId,
        'unsupported_source',
        data.correlationId,
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Replay not supported for source queue "${data.sourceQueue}"`,
      });
    }

    // Claim BEFORE publishing. Without this, two concurrent replays both publish
    // — and because the replay job id is deliberately unique per attempt (below),
    // the source queue would not collapse them into one.
    const lockKey = `dlq:replay:${QUEUE.WHATSAPP_DLQ}:${jobId}`;
    const token = await this.locks.acquire(lockKey, REPLAY_LOCK_TTL_MS);
    if (!token) {
      await this.audit(
        'whatsapp.dlq.replay',
        jobId,
        'already_in_flight',
        data.correlationId,
      );
      throw this.notFound();
    }

    try {
      // A fresh jobId (Date.now() suffix) is required: BullMQ's default jobId
      // for both source queues is deterministic (`wa-webhook-<id>` /
      // `wa-media-<messageId>-<mediaId>`), and the original job may still exist
      // in BullMQ's retained `failed` set — re-adding under the same id would
      // be a silent no-op rather than a real retry.
      const replayData = {
        ...data.originalData,
        correlationId: data.correlationId,
      } as unknown as BaseJobData;
      await this.queue.publish(
        sourceQueue,
        data.sourceJobName,
        replayData,
        `${data.sourceJobName}-replay-${data.originalJobId ?? job.id}-${Date.now()}`,
      );

      // Remove only after a confirmed publish. If removal fails the job may be
      // replayed again later — an at-most-once claim plus a retained entry is
      // strictly safer than dropping the entry on an unconfirmed publish.
      await job.remove();
      await this.audit(
        'whatsapp.dlq.replay',
        jobId,
        'replayed',
        data.correlationId,
      );
      this.logger.log(`Replayed DLQ job ${jobId} → ${sourceQueue}`);
      return { replayed: true, jobId };
    } catch (err) {
      // Publish (or removal) failed after the claim succeeded. Leave the parked
      // entry in place so the job is never lost, and release the claim so it is
      // retryable immediately rather than waiting out the TTL (FR-012b).
      await this.audit(
        'whatsapp.dlq.replay',
        jobId,
        'failed',
        data.correlationId,
      );
      throw err;
    } finally {
      await this.locks.release(lockKey, token).catch(() => undefined);
    }
  }

  /** Discard a parked job without replaying. */
  async discard(jobId: string) {
    const tenantId = this.tenantContext.requireTenantId();
    const dlq = this.queue.queue(QUEUE.WHATSAPP_DLQ);
    const job = await dlq.getJob(jobId);

    const data = job?.data as WhatsappDlqJob | undefined;
    if (!job || !data || !this.ownsJob(data, tenantId)) {
      await this.audit('whatsapp.dlq.discard', jobId, 'rejected', undefined);
      throw this.notFound();
    }

    await job.remove();
    await this.audit(
      'whatsapp.dlq.discard',
      jobId,
      'discarded',
      data.correlationId,
    );
    return { discarded: true, jobId };
  }

  // ──────────────────────────────── Internals ────────────────────────────────

  /**
   * True only when the parked job records the caller's tenant. A job with no
   * recorded owner is treated as NOT owned — fail closed, never visible to all.
   */
  private ownsJob(data: WhatsappDlqJob | undefined, tenantId: string): boolean {
    return Boolean(data?.tenantId) && data?.tenantId === tenantId;
  }

  /**
   * Operational fields only. `originalData` is deliberately NOT returned: for
   * this queue it carries recipient identifiers and template variables (SR-005).
   * `tenantId` is omitted too — it is necessarily the caller's own tenant, so
   * returning it is redundant and invites reuse as an input.
   */
  private toSummary(jobId: string | undefined, d: WhatsappDlqJob) {
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
   * content, message bodies, phone numbers, template variables or credentials
   * (SR-010, OB-005). The DLQ job id goes in the jsonb detail rather than
   * `entity_id`, which is a uuid column and BullMQ ids are not uuids.
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
          entity_type: 'whatsapp_dlq_job',
          new_values: {
            jobId,
            result,
            correlationId:
              correlationId ?? this.tenantContext.getCorrelationId() ?? null,
          },
        }),
      );
    } catch (err) {
      // Auditing must never mask or block the security decision it records.
      this.logger.warn(`DLQ audit write failed: ${(err as Error).message}`);
    }
  }
}
