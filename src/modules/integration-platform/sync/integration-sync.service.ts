import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, LessThan, Repository } from 'typeorm';

import { IntegrationSyncJob } from '../../../entities/Integration/IntegrationSyncJob';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { User } from '../../../entities/Auth&RBAC/User';
import { AppError, ErrorCode, isUniqueViolation } from '../../../common/errors';
import { QueueService } from '../../../queue/queue.service';

import { StartSyncDto } from '../dto/start-sync.dto';
import { QueryJobsDto } from '../dto/query-jobs.dto';
import {
  ACTIVE_JOB_STATUSES,
  ADMISSION_OP,
  IntegrationResource,
  JOB_STATUS,
  SYNC_DIRECTION,
  SYNC_MODE,
  TERMINAL_JOB_STATUSES,
  UPSERT_OUTCOME,
} from '../integration-platform.constants';
import { IntegrationAdmissionService } from '../admission/integration-admission.service';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationUpsertService } from '../write/integration-upsert.service';
import { IntegrationProviderService } from '../providers/integration-provider.service';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';

interface Actor {
  userId?: string;
  ip?: string;
}

/** Max pages pulled in one run (safety bound against a runaway provider). */
const MAX_SYNC_PAGES = 1_000;

/**
 * Queue-based synchronization engine (Phase 4). A run is a durable
 * `integration_sync_jobs` row; the table is both live state and run history.
 *
 * `start` enforces duplicate-active-job prevention at the DATABASE level (a
 * partial unique index rejects a second active row for the same
 * tenant/connection/resource/direction) and returns the tenant-facing job id.
 * The worker (`process`) pulls bounded pages from the provider adapter and writes
 * each record through the SHARED upsert pipeline (idempotent — never claims
 * exactly-once), advancing the cursor after every page so a failed/interrupted
 * run RESUMES from the last successful watermark.
 */
@Injectable()
export class IntegrationSyncService {
  private readonly logger = new Logger(IntegrationSyncService.name);

  constructor(
    @InjectRepository(IntegrationSyncJob) private readonly jobs: Repository<IntegrationSyncJob>,
    private readonly connections: IntegrationConnectionService,
    private readonly upsert: IntegrationUpsertService,
    private readonly providers: IntegrationProviderService,
    private readonly audit: IntegrationAuditService,
    private readonly queue: QueueService,
    private readonly admission: IntegrationAdmissionService,
  ) {}

  // ── HTTP path ─────────────────────────────────────────────────────────────

  async start(tenantId: string, dto: StartSyncDto, actor: Actor, op: string = ADMISSION_OP.SYNC_START) {
    // Admission before any row is created: rate (fail-closed) + a DB-backed
    // concurrency cap. The partial unique index is the final duplicate guard.
    await this.admission.admit(op as never, { tenantId, connectionId: dto.connectionId });
    await this.admission.assertSyncConcurrency(tenantId);

    const connection = await this.connections.requireActive(tenantId, dto.connectionId);
    const resource = dto.resourceType as IntegrationResource;
    const direction = dto.direction;
    const mode = dto.mode ?? SYNC_MODE.INCREMENTAL;

    this.assertDirectionAllowed(connection, direction);

    // For incremental, resume from the most recent successful cursor for this
    // tuple; for full, ignore it (backfill/full re-scan from the start).
    const cursor =
      mode === SYNC_MODE.INCREMENTAL ? await this.lastSuccessfulCursor(tenantId, dto.connectionId, resource, direction) : null;

    try {
      const job = await this.jobs.save(
        this.jobs.create({
          tenant: { id: tenantId } as Tenant,
          connection: { id: dto.connectionId } as IntegrationConnection,
          resource_type: resource,
          direction,
          mode,
          status: JOB_STATUS.PENDING,
          cursor,
          last_successful_cursor: cursor,
          triggered_by: actor.userId ? ({ id: actor.userId } as User) : null,
        }),
      );

      try {
        await this.queue.enqueueIntegrationSync({ tenantId, syncJobId: job.id });
      } catch (err) {
        this.logger.error(`sync job ${job.id} enqueue failed (kept pending): ${(err as Error)?.message}`);
      }

      await this.audit.record(INTEGRATION_AUDIT_ACTION.IMPORT, tenantId, resource, job.id, actor, {
        action: 'sync.start', connectionId: dto.connectionId, direction, mode,
      });
      return this.toView(job);
    } catch (err) {
      // DB partial unique index → a run is already active for this tuple.
      if (isUniqueViolation(err)) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'A sync is already running for this connection, resource and direction',
        });
      }
      throw err;
    }
  }

  async getStatus(tenantId: string, jobId: string) {
    return this.toView(await this.findOrThrow(tenantId, jobId));
  }

  async list(tenantId: string, query: QueryJobsDto) {
    const where: FindOptionsWhere<IntegrationSyncJob> = { tenant: { id: tenantId } };
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

  async cancel(tenantId: string, jobId: string, actor: Actor) {
    const job = await this.findOrThrow(tenantId, jobId);
    if (TERMINAL_JOB_STATUSES.includes(job.status as never)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Sync run is already finished' });
    }
    job.cancel_requested = true;
    if (job.status === JOB_STATUS.PENDING) {
      job.status = JOB_STATUS.CANCELLED;
      job.finished_at = new Date();
    }
    await this.jobs.save(job);
    await this.audit.record(INTEGRATION_AUDIT_ACTION.IMPORT, tenantId, job.resource_type, jobId, actor, { action: 'sync.cancel' });
    return this.toView(job);
  }

  /** Retry/resume a finished-but-not-completed run by starting a fresh run from its cursor. */
  async retry(tenantId: string, jobId: string, actor: Actor) {
    const prior = await this.findOrThrow(tenantId, jobId);
    if (!TERMINAL_JOB_STATUSES.includes(prior.status as never)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Only a finished run can be retried' });
    }
    return this.start(
      tenantId,
      {
        connectionId: prior.connection?.id as string,
        resourceType: prior.resource_type,
        direction: prior.direction,
        mode: SYNC_MODE.INCREMENTAL,
      },
      actor,
      ADMISSION_OP.SYNC_RETRY,
    );
  }

  // ── Worker path ─────────────────────────────────────────────────────────────

  async process(syncJobId: string): Promise<void> {
    const job = await this.jobs.findOne({
      where: { id: syncJobId },
      relations: { tenant: true, connection: true },
    });
    if (!job) {
      this.logger.warn(`sync job ${syncJobId} not found — skipping`);
      return;
    }
    if (TERMINAL_JOB_STATUSES.includes(job.status as never)) {
      this.logger.log(`sync job ${syncJobId} already terminal (${job.status}) — skipping`);
      return;
    }

    const tenantId = (job.tenant as Tenant).id;
    const resource = job.resource_type as IntegrationResource;

    job.status = JOB_STATUS.RUNNING;
    job.started_at = job.started_at ?? new Date();
    job.retry_count += 1;
    await this.jobs.save(job);

    let connection: IntegrationConnection;
    try {
      if (!job.connection?.id) throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'Connection was removed' });
      connection = await this.connections.requireActive(tenantId, job.connection.id);
    } catch (err) {
      await this.finish(job, JOB_STATUS.FAILED, (err as Error)?.message ?? 'Connection is not active');
      await this.connections.markError(job.connection?.id ?? '', 'Sync connection not active');
      return;
    }

    // Outbound sync via the built-in providers is a no-op push; inbound pulls
    // bounded pages. Neither fabricates data (no real endpoint is wired).
    if (job.direction === SYNC_DIRECTION.OUTBOUND) {
      await this.finish(job, JOB_STATUS.COMPLETED, null);
      await this.connections.markSuccess(connection.id);
      return;
    }

    const policy = this.connections.conflictPolicyOf(connection);
    let cursor = job.cursor ?? null;
    let pages = 0;

    try {
      while (pages < MAX_SYNC_PAGES) {
        const fresh = await this.jobs.findOne({ where: { id: syncJobId }, select: { cancel_requested: true } });
        if (fresh?.cancel_requested) {
          await this.finish(job, JOB_STATUS.CANCELLED, null);
          return;
        }

        const page = await this.providers.pullChanges(connection, resource, cursor);
        for (const rec of page.records) {
          const result = await this.upsert.upsertOne(
            tenantId, resource, connection.id, policy, rec.externalId, rec.data,
            { userId: job.triggered_by?.id }, { safe: true },
          );
          this.tally(job, result.outcome);
          job.processed += 1;
        }

        cursor = page.nextCursor;
        job.cursor = cursor;
        job.last_successful_cursor = cursor; // page committed → safe resume point
        await this.jobs.save(job);
        pages += 1;
        if (!page.hasMore) break;
      }

      const status = job.failed_count === 0 ? JOB_STATUS.COMPLETED : JOB_STATUS.PARTIALLY_COMPLETED;
      await this.finish(job, status, status === JOB_STATUS.PARTIALLY_COMPLETED ? 'Some records failed' : null);
      await this.connections.markSuccess(connection.id);
    } catch (err) {
      // Interrupted mid-run — leave last_successful_cursor as the resume point
      // and mark failed so a retry resumes from there. Re-throw so BullMQ retries.
      await this.finish(job, JOB_STATUS.FAILED, (err as Error)?.message ?? 'Sync failed');
      await this.connections.markError(connection.id, (err as Error)?.message ?? 'Sync failed');
      throw err;
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async finish(job: IntegrationSyncJob, status: string, errorSummary: string | null): Promise<void> {
    job.status = status;
    job.finished_at = new Date();
    if (errorSummary) job.error_summary = errorSummary.slice(0, 500);
    await this.jobs.save(job);
  }

  private assertDirectionAllowed(connection: IntegrationConnection, direction: string): void {
    const configured = connection.sync_direction;
    if (configured === SYNC_DIRECTION.BIDIRECTIONAL) return;
    if (configured !== direction) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Connection sync direction is "${configured}"; cannot start a ${direction} sync`,
      });
    }
  }

  private async lastSuccessfulCursor(
    tenantId: string,
    connectionId: string,
    resource: IntegrationResource,
    direction: string,
  ): Promise<string | null> {
    const last = await this.jobs.findOne({
      where: {
        tenant: { id: tenantId },
        connection: { id: connectionId },
        resource_type: resource,
        direction,
        status: In([JOB_STATUS.COMPLETED, JOB_STATUS.PARTIALLY_COMPLETED, JOB_STATUS.FAILED]),
      },
      order: { created_at: 'DESC' },
    });
    return last?.last_successful_cursor ?? null;
  }

  private tally(job: IntegrationSyncJob, outcome: string): void {
    switch (outcome) {
      case UPSERT_OUTCOME.CREATED: job.created_count += 1; break;
      case UPSERT_OUTCOME.UPDATED: job.updated_count += 1; break;
      case UPSERT_OUTCOME.SKIPPED:
      case UPSERT_OUTCOME.LINKED: job.skipped_count += 1; break;
      case UPSERT_OUTCOME.CONFLICTED: job.conflicted_count += 1; break;
      case UPSERT_OUTCOME.FAILED: job.failed_count += 1; break;
    }
  }

  private async findOrThrow(tenantId: string, jobId: string): Promise<IntegrationSyncJob> {
    const job = await this.jobs.findOne({
      where: { id: jobId, tenant: { id: tenantId } },
      relations: { connection: true },
    });
    if (!job) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Sync run not found' });
    return job;
  }

  private toView(j: IntegrationSyncJob) {
    return {
      id: j.id,
      connectionId: j.connection?.id ?? null,
      resourceType: j.resource_type,
      direction: j.direction,
      mode: j.mode,
      status: j.status,
      cursor: j.cursor ?? null,
      lastSuccessfulCursor: j.last_successful_cursor ?? null,
      counts: {
        processed: j.processed,
        created: j.created_count,
        updated: j.updated_count,
        skipped: j.skipped_count,
        conflicted: j.conflicted_count,
        failed: j.failed_count,
      },
      retryCount: j.retry_count,
      scheduled: j.scheduled,
      cancelRequested: j.cancel_requested,
      errorSummary: j.error_summary ?? null,
      startedAt: j.started_at ?? null,
      finishedAt: j.finished_at ?? null,
      durationMs: j.started_at && j.finished_at ? j.finished_at.getTime() - j.started_at.getTime() : null,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
    };
  }

  /** Recover runs left active by a dead worker/enqueue failure (idempotent). */
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
        .enqueueIntegrationSync({ tenantId: (job.tenant as Tenant)?.id ?? null, syncJobId: job.id })
        .then(() => (requeued += 1))
        .catch(() => undefined);
    }
    return requeued;
  }
}
