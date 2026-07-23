import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, LessThan, Repository } from 'typeorm';

import { IntegrationImportJob } from '../../../entities/Integration/IntegrationImportJob';
import { IntegrationImportItem } from '../../../entities/Integration/IntegrationImportItem';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { User } from '../../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../../common/errors';
import { QueueService } from '../../../queue/queue.service';

import { CreateImportJobDto } from '../dto/create-import-job.dto';
import { QueryJobsDto } from '../dto/query-jobs.dto';
import {
  ACTIVE_JOB_STATUSES,
  ADMISSION_OP,
  IMPORT_ITEM_STATUS,
  IMPORT_MODE,
  IntegrationResource,
  JOB_STATUS,
  MAX_ASYNC_IMPORT_BATCH,
  MAX_UPSERT_PAYLOAD_BYTES,
  TERMINAL_JOB_STATUSES,
  UPSERT_OUTCOME,
} from '../integration-platform.constants';
import { IntegrationAdmissionService } from '../admission/integration-admission.service';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationUpsertService } from '../write/integration-upsert.service';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';

interface Actor {
  userId?: string;
  ip?: string;
}

/**
 * Async, queue-based import pipeline (Phase 4) — the PRIMARY production import
 * flow. The HTTP path (`create`) validates, persists a durable job row (status
 * `pending`) with a server-only staged payload, enqueues one BullMQ job, and
 * returns the tenant-facing job id immediately. The worker (`process`) drains the
 * staged records through the SHARED write pipeline (IntegrationUpsertService) —
 * there is no second mutation path — updating counts/progress on the row so the
 * run is observable, cancellable, retryable and recoverable after a restart.
 *
 * The staged payload is retained ONLY while needed: cleared on a clean success
 * or cancellation, trimmed to just the failed records on a partial/failed run so
 * a retry can re-process them, and never exposed to any client.
 */
@Injectable()
export class IntegrationImportJobService {
  private readonly logger = new Logger(IntegrationImportJobService.name);
  private static readonly PROGRESS_FLUSH_EVERY = 25;

  constructor(
    @InjectRepository(IntegrationImportJob) private readonly jobs: Repository<IntegrationImportJob>,
    @InjectRepository(IntegrationImportItem) private readonly items: Repository<IntegrationImportItem>,
    private readonly connections: IntegrationConnectionService,
    private readonly upsert: IntegrationUpsertService,
    private readonly audit: IntegrationAuditService,
    private readonly queue: QueueService,
    private readonly admission: IntegrationAdmissionService,
  ) {}

  // ── HTTP path ─────────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    resource: IntegrationResource,
    dto: CreateImportJobDto,
    actor: Actor,
  ): Promise<{ jobId: string; status: string; total: number }> {
    if (!this.upsert.supports(resource)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Import is not yet supported for resource "${resource}"`,
      });
    }
    if ((dto.mode ?? IMPORT_MODE.PARTIAL) === IMPORT_MODE.ATOMIC) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Atomic import mode is not yet available; use partial (default) mode',
      });
    }
    if (dto.records.length > MAX_ASYNC_IMPORT_BATCH) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Import exceeds the maximum of ${MAX_ASYNC_IMPORT_BATCH} records`,
      });
    }
    // Admission BEFORE persistence/enqueue — size, rate (fail-closed), and a
    // DB-backed concurrency cap that stays correct even during a Redis outage.
    this.admission.assertPayloadSize(dto.records, MAX_UPSERT_PAYLOAD_BYTES * 40, 'import batch');
    await this.admission.admit(ADMISSION_OP.IMPORT_CREATE, { tenantId, connectionId: dto.connectionId });
    await this.admission.assertImportConcurrency(tenantId);

    // Connection must be ACTIVE at accept time (re-checked at process time too).
    await this.connections.requireActive(tenantId, dto.connectionId);

    const payload = dto.records.map((r) => ({ externalId: r.externalId, data: r.data }));

    const job = await this.jobs.save(
      this.jobs.create({
        tenant: { id: tenantId } as Tenant,
        connection: { id: dto.connectionId } as IntegrationConnection,
        resource_type: resource,
        status: JOB_STATUS.PENDING,
        mode: IMPORT_MODE.PARTIAL,
        dry_run: !!dto.dryRun,
        total: payload.length,
        requested_by: actor.userId ? ({ id: actor.userId } as User) : null,
        payload,
      }),
    );

    // Persist-then-enqueue: the row already exists, so an enqueue failure never
    // loses the job — it stays `pending` and the recovery sweep re-enqueues it.
    try {
      await this.queue.enqueueIntegrationImport({ tenantId, importJobId: job.id });
    } catch (err) {
      this.logger.error(
        `import job ${job.id} enqueue failed (kept pending for recovery): ${(err as Error)?.message}`,
      );
    }

    await this.audit.record(INTEGRATION_AUDIT_ACTION.IMPORT, tenantId, resource, job.id, actor, {
      connectionId: dto.connectionId, mode: 'async', total: payload.length, dryRun: !!dto.dryRun,
    });
    return { jobId: job.id, status: job.status, total: job.total };
  }

  async getStatus(tenantId: string, jobId: string) {
    const job = await this.findOrThrow(tenantId, jobId);
    return this.toView(job);
  }

  async list(tenantId: string, query: QueryJobsDto) {
    const where: FindOptionsWhere<IntegrationImportJob> = { tenant: { id: tenantId } };
    if (query.connectionId) where.connection = { id: query.connectionId };
    if (query.resourceType) where.resource_type = query.resourceType;
    if (query.status) where.status = query.status;

    const [rows, total] = await this.jobs.findAndCount({
      where,
      relations: { connection: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data: rows.map((j) => this.toView(j)), total, page: query.page, limit: query.limit };
  }

  async listItems(tenantId: string, jobId: string, page = 1, limit = 50) {
    await this.findOrThrow(tenantId, jobId);
    const [rows, total] = await this.items.findAndCount({
      where: { job: { id: jobId } },
      order: { created_at: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      data: rows.map((i) => ({
        externalId: i.external_id,
        outcome: i.outcome,
        status: i.status,
        internalResourceId: i.internal_resource_id ?? null,
        changedFields: i.changed_fields ?? undefined,
        error: i.error ?? undefined,
      })),
      total,
      page,
      limit,
    };
  }

  /** Request cancellation. A not-yet-started job is cancelled immediately. */
  async cancel(tenantId: string, jobId: string, actor: Actor) {
    const job = await this.findOrThrow(tenantId, jobId);
    if (TERMINAL_JOB_STATUSES.includes(job.status as never)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Job is already finished' });
    }
    job.cancel_requested = true;
    if (job.status === JOB_STATUS.PENDING) {
      job.status = JOB_STATUS.CANCELLED;
      job.finished_at = new Date();
      job.payload = null;
    }
    await this.jobs.save(job);
    await this.audit.record(INTEGRATION_AUDIT_ACTION.IMPORT, tenantId, job.resource_type, jobId, actor, {
      action: 'cancel',
    });
    return this.toView(job);
  }

  /** Retry the failed items of a terminal job (re-enqueues; idempotent upsert). */
  async retry(tenantId: string, jobId: string, actor: Actor) {
    const job = await this.jobWithPayload(tenantId, jobId);
    if (!TERMINAL_JOB_STATUSES.includes(job.status as never)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Only a finished job can be retried' });
    }
    if (!job.payload || job.payload.length === 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'No retryable records remain for this job',
      });
    }
    await this.admission.admit(ADMISSION_OP.IMPORT_RETRY, {
      tenantId,
      connectionId: job.connection?.id ?? null,
    });
    await this.admission.assertImportConcurrency(tenantId);
    job.status = JOB_STATUS.PENDING;
    job.cancel_requested = false;
    job.processed = 0;
    job.finished_at = null;
    job.error_summary = null;
    await this.jobs.save(job);
    // Reset any previously-failed items to pending for a clean re-run tally.
    await this.items.update({ job: { id: jobId }, status: IMPORT_ITEM_STATUS.FAILED }, { status: IMPORT_ITEM_STATUS.PENDING });
    try {
      await this.queue.retryIntegrationImport({ tenantId, importJobId: jobId });
    } catch (err) {
      this.logger.error(`import job ${jobId} retry enqueue failed (kept pending): ${(err as Error)?.message}`);
    }
    return this.toView(job);
  }

  // ── Worker path ─────────────────────────────────────────────────────────────

  /**
   * Process one import job. Idempotent + safely retryable: a terminal job is a
   * no-op, and re-processing a partially-done job is safe because every write
   * goes through the idempotent upsert pipeline (mapping makes a repeat a no-op).
   */
  async process(jobId: string): Promise<void> {
    const job = await this.jobs
      .createQueryBuilder('j')
      .addSelect('j.payload')
      .leftJoinAndSelect('j.tenant', 'tenant')
      .leftJoinAndSelect('j.connection', 'connection')
      .where('j.id = :id', { id: jobId })
      .getOne();
    if (!job) {
      this.logger.warn(`import job ${jobId} not found — skipping`);
      return;
    }
    if (TERMINAL_JOB_STATUSES.includes(job.status as never)) {
      this.logger.log(`import job ${jobId} already terminal (${job.status}) — skipping`);
      return;
    }

    const tenantId = (job.tenant as Tenant).id;
    const connectionId = job.connection?.id;
    const resource = job.resource_type as IntegrationResource;

    job.status = JOB_STATUS.RUNNING;
    job.started_at = job.started_at ?? new Date();
    await this.jobs.save(job);

    let connection: IntegrationConnection;
    try {
      if (!connectionId) throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Connection was removed' });
      connection = await this.connections.requireActive(tenantId, connectionId);
    } catch (err) {
      await this.finish(job, JOB_STATUS.FAILED, (err as Error)?.message ?? 'Connection is not active');
      return;
    }
    const policy = this.connections.conflictPolicyOf(connection);

    const records = job.payload ?? [];
    const seen = new Set<string>();
    const remaining: Array<{ externalId: string; data: Record<string, unknown> }> = [];
    let cancelled = false;

    for (const record of records) {
      const fresh = await this.jobs.findOne({ where: { id: jobId }, select: { cancel_requested: true } });
      if (fresh?.cancel_requested) {
        cancelled = true;
        break;
      }

      if (seen.has(record.externalId)) {
        job.duplicates_in_batch += 1;
        job.skipped_count += 1;
        job.processed += 1;
        await this.recordItem(job, record.externalId, UPSERT_OUTCOME.SKIPPED, null, undefined, 'Duplicate external id within the same import');
        continue;
      }
      seen.add(record.externalId);

      const result = await this.upsert.upsertOne(
        tenantId, resource, connection.id, policy, record.externalId, record.data,
        { userId: job.requested_by?.id }, { safe: true, dryRun: job.dry_run },
      );
      this.tally(job, result.outcome);
      job.processed += 1;
      await this.recordItem(job, result.externalId, result.outcome, result.internalId, result.changedFields, result.error);
      if (result.outcome === UPSERT_OUTCOME.FAILED) remaining.push(record);

      if (job.processed % IntegrationImportJobService.PROGRESS_FLUSH_EVERY === 0) {
        await this.jobs.update({ id: jobId }, { processed: job.processed });
      }
    }

    if (cancelled) {
      await this.finish(job, JOB_STATUS.CANCELLED, null, []);
      return;
    }

    const status = job.failed_count === 0
      ? JOB_STATUS.COMPLETED
      : job.failed_count === job.total
        ? JOB_STATUS.FAILED
        : JOB_STATUS.PARTIALLY_COMPLETED;
    // Retain only the failed records for retry; drop everything else.
    await this.finish(job, status, status === JOB_STATUS.FAILED ? 'All records failed' : null, remaining);

    if (!job.dry_run) {
      await this.connections.markSuccess(connection.id);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async finish(
    job: IntegrationImportJob,
    status: string,
    errorSummary: string | null,
    retainPayload?: Array<{ externalId: string; data: Record<string, unknown> }>,
  ): Promise<void> {
    job.status = status;
    job.finished_at = new Date();
    if (errorSummary) job.error_summary = errorSummary.slice(0, 500);
    // Clear the staged payload unless we deliberately retain failed records.
    job.payload = retainPayload && retainPayload.length > 0 ? retainPayload : null;
    await this.jobs.save(job);
  }

  private async recordItem(
    job: IntegrationImportJob,
    externalId: string,
    outcome: string,
    internalId: string | null,
    changedFields?: string[],
    error?: string,
  ): Promise<void> {
    await this.items
      .save(
        this.items.create({
          job: { id: job.id } as IntegrationImportJob,
          external_id: externalId,
          outcome,
          status: outcome === UPSERT_OUTCOME.FAILED ? IMPORT_ITEM_STATUS.FAILED : IMPORT_ITEM_STATUS.DONE,
          internal_resource_id: internalId,
          changed_fields: changedFields ?? null,
          error: error ? error.slice(0, 300) : null,
        }),
      )
      .catch((e) => this.logger.warn(`import item persist failed: ${(e as Error)?.message}`));
  }

  private tally(job: IntegrationImportJob, outcome: string): void {
    switch (outcome) {
      case UPSERT_OUTCOME.CREATED: job.created_count += 1; break;
      case UPSERT_OUTCOME.UPDATED: job.updated_count += 1; break;
      case UPSERT_OUTCOME.LINKED: job.linked_count += 1; break;
      case UPSERT_OUTCOME.SKIPPED: job.skipped_count += 1; break;
      case UPSERT_OUTCOME.CONFLICTED: job.conflicted_count += 1; break;
      case UPSERT_OUTCOME.FAILED: job.failed_count += 1; break;
    }
  }

  private async findOrThrow(tenantId: string, jobId: string): Promise<IntegrationImportJob> {
    const job = await this.jobs.findOne({
      where: { id: jobId, tenant: { id: tenantId } },
      relations: { connection: true },
    });
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Import job not found' });
    return job;
  }

  private async jobWithPayload(tenantId: string, jobId: string): Promise<IntegrationImportJob> {
    const job = await this.jobs
      .createQueryBuilder('j')
      .addSelect('j.payload')
      .leftJoinAndSelect('j.connection', 'connection')
      .where('j.id = :id AND j.tenantId = :tenantId', { id: jobId, tenantId })
      .getOne();
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Import job not found' });
    return job;
  }

  private toView(j: IntegrationImportJob) {
    return {
      id: j.id,
      connectionId: j.connection?.id ?? null,
      resourceType: j.resource_type,
      status: j.status,
      mode: j.mode,
      dryRun: j.dry_run,
      progress: { processed: j.processed, total: j.total },
      counts: {
        created: j.created_count,
        updated: j.updated_count,
        linked: j.linked_count,
        skipped: j.skipped_count,
        conflicted: j.conflicted_count,
        failed: j.failed_count,
        duplicatesInBatch: j.duplicates_in_batch,
      },
      cancelRequested: j.cancel_requested,
      errorSummary: j.error_summary ?? null,
      requestedBy: j.requested_by?.id ?? null,
      startedAt: j.started_at ?? null,
      finishedAt: j.finished_at ?? null,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
    };
  }

  // ── Recovery sweep (worker) ─────────────────────────────────────────────────

  /**
   * Re-enqueue jobs left `pending` (enqueue failed) or `running` (worker died)
   * so no accepted import silently disappears. Idempotent: the deterministic
   * jobId collapses duplicates and terminal jobs short-circuit in `process`.
   */
  async recoverStale(olderThanMs = 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.jobs.find({
      where: { status: In(ACTIVE_JOB_STATUSES), updated_at: LessThan(cutoff) },
      relations: { tenant: true },
      take: 100,
    });
    let requeued = 0;
    for (const job of stale) {
      await this.queue
        .enqueueIntegrationImport({ tenantId: (job.tenant as Tenant)?.id ?? null, importJobId: job.id })
        .then(() => (requeued += 1))
        .catch(() => undefined);
    }
    return requeued;
  }
}
