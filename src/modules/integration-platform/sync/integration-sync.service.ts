import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In, LessThan, Repository } from 'typeorm';

import { IntegrationSyncJob } from '../../../entities/Integration/IntegrationSyncJob';
import { IntegrationConnection } from '../../../entities/Integration/IntegrationConnection';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { User } from '../../../entities/Auth&RBAC/User';
import { OutboxJob } from '../../../entities/Campaigns/OutboxJob';
import { AppError, ErrorCode, isUniqueViolation } from '../../../common/errors';
import { QueueService } from '../../../queue/queue.service';
import { QUEUE, JOB } from '../../../queue/queue.constants';

import { StartSyncDto } from '../dto/start-sync.dto';
import { QueryJobsDto } from '../dto/query-jobs.dto';
import {
  ACTIVE_JOB_STATUSES,
  ADMISSION_OP,
  IntegrationResource,
  JOB_STATUS,
  MAPPING_SOURCE,
  MAX_SYNC_PAGES,
  MAX_SYNC_RECORDS,
  MAX_SYNC_RUNTIME_MS,
  OUTBOUND_SYNC_PAGE_SIZE,
  SYNC_DIRECTION,
  SYNC_MODE,
  SYNC_STOP_REASON,
  SyncStopReason,
  TERMINAL_JOB_STATUSES,
  UPSERT_OUTCOME,
} from '../integration-platform.constants';
import { IntegrationAdmissionService } from '../admission/integration-admission.service';
import { IntegrationConnectionService } from '../connections/integration-connection.service';
import { IntegrationUpsertService } from '../write/integration-upsert.service';
import { IntegrationServiceAccountService } from '../write/integration-service-account.service';
import { IntegrationProviderService } from '../providers/integration-provider.service';
import { IntegrationIdMapService } from '../mappings/integration-id-map.service';
import { ProviderPushRecord } from '../providers/provider.types';
import { IntegrationAuditService, INTEGRATION_AUDIT_ACTION } from '../integration-audit.service';

interface Actor {
  userId?: string;
  ip?: string;
}

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
    private readonly serviceAccount: IntegrationServiceAccountService,
    private readonly idMap: IntegrationIdMapService,
    private readonly dataSource: DataSource,
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

    this.connections.assertResourceEnabled(connection, resource);
    this.assertDirectionAllowed(connection, resource, direction);

    // For incremental, resume from the most recent successful cursor for this
    // tuple; for full, ignore it (backfill/full re-scan from the start).
    const cursor =
      mode === SYNC_MODE.INCREMENTAL ? await this.lastSuccessfulCursor(tenantId, dto.connectionId, resource, direction) : null;

    try {
      // Job row + enqueue-intent in ONE transaction via the transactional
      // outbox (Phase 0 — see docs/CACHING_QUEUES_AUDIT.md §0.5 item 4 /
      // original audit H6). See IntegrationImportJobService.create for the
      // identical pattern and rationale.
      const job = await this.dataSource.transaction(async (mgr) => {
        const created = await mgr.save(
          mgr.create(IntegrationSyncJob, {
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
        await mgr.save(
          mgr.create(OutboxJob, {
            queue: QUEUE.INTEGRATION_SYNC,
            job_name: JOB.INTEGRATION_SYNC,
            dedupe_key: `integration-sync-${created.id}`,
            payload: { tenantId, syncJobId: created.id },
          }),
        );
        return created;
      });

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

    if (job.direction === SYNC_DIRECTION.OUTBOUND) {
      await this.processOutbound(job, connection, resource, tenantId);
      return;
    }

    const policy = this.connections.conflictPolicyOf(connection);
    // Attribute records to the triggering user, or to the tenant's verified
    // integration service account for a scheduled/machine run.
    const actorUserId = await this.serviceAccount.resolveActorUserId(tenantId, job.triggered_by?.id);

    // Resume from the last SAFE watermark, never from a boundary that was merely
    // attempted — a page containing a failed record must be re-fetched.
    let cursor = job.last_successful_cursor ?? job.cursor ?? null;
    let pages = 0;
    let stop: SyncStopReason = SYNC_STOP_REASON.COMPLETED;
    const deadline = Date.now() + MAX_SYNC_RUNTIME_MS;
    /** Boundaries already requested — a repeat means the provider is looping. */
    const seenCursors = new Set<string>();

    try {
      while (true) {
        if (pages >= MAX_SYNC_PAGES) { stop = SYNC_STOP_REASON.MAX_PAGES; break; }
        if (job.processed >= MAX_SYNC_RECORDS) { stop = SYNC_STOP_REASON.MAX_RECORDS; break; }
        if (Date.now() > deadline) { stop = SYNC_STOP_REASON.MAX_RUNTIME; break; }

        const fresh = await this.jobs.findOne({ where: { id: syncJobId }, select: { cancel_requested: true } });
        if (fresh?.cancel_requested) {
          job.stop_reason = SYNC_STOP_REASON.CANCELLED;
          await this.finish(job, JOB_STATUS.CANCELLED, null);
          return;
        }

        // PAGINATION-LOOP GUARD: asking for a boundary we already asked for in
        // this run means the provider is not advancing. Stop rather than spin.
        const key = cursor ?? ' start';
        if (seenCursors.has(key)) { stop = SYNC_STOP_REASON.REPEATED_CURSOR; break; }
        seenCursors.add(key);

        job.attempted_cursor = cursor;
        const page = await this.providers.pullChanges(connection, resource, cursor);
        job.next_cursor = page.nextCursor ?? null;
        pages += 1;
        job.pages_fetched = pages;

        // Per-item processing. Records may arrive DUPLICATED or OUT OF ORDER —
        // both are safe: the external-id mapping makes a repeat an idempotent
        // no-op update, and each record is applied on its own merits rather than
        // by position in the stream.
        let pageFullyHandled = true;
        const seenInPage = new Set<string>();
        for (const rec of page.records) {
          if (seenInPage.has(rec.externalId)) {
            // Same record twice in one page — count once, skip the rework.
            job.skipped_count += 1;
            job.processed += 1;
            continue;
          }
          seenInPage.add(rec.externalId);

          const result = await this.upsert.upsertOne(
            tenantId, resource, connection.id, policy, rec.externalId, rec.data,
            { userId: actorUserId }, { safe: true },
          );
          this.tally(job, result.outcome);
          job.processed += 1;
          // A FAILED record blocks the watermark. A conflict does not: it is
          // durably recorded for review, so the record is accounted for.
          if (result.outcome === UPSERT_OUTCOME.FAILED) pageFullyHandled = false;
        }

        if (!pageFullyHandled) {
          // PARTIAL-PAGE FAILURE: do NOT advance last_successful_cursor. The run
          // ends here so a retry re-fetches this exact page — a record that was
          // not safely handled can never be skipped past.
          stop = SYNC_STOP_REASON.ITEM_FAILURE;
          await this.jobs.save(job);
          break;
        }

        // Whole page handled → this boundary is a safe resume point.
        cursor = page.nextCursor;
        job.cursor = cursor;
        job.last_successful_cursor = cursor;
        await this.jobs.save(job);

        if (!page.hasMore) { stop = SYNC_STOP_REASON.COMPLETED; break; }
      }

      job.stop_reason = stop;
      const clean = job.failed_count === 0 && stop === SYNC_STOP_REASON.COMPLETED;
      const status = clean ? JOB_STATUS.COMPLETED : JOB_STATUS.PARTIALLY_COMPLETED;
      await this.finish(job, status, clean ? null : this.stopSummary(stop, job.failed_count));
      await this.connections.markSuccess(connection.id);
    } catch (err) {
      // Interrupted mid-run — last_successful_cursor still points at the last
      // fully-handled page, so a retry resumes there. Re-throw so BullMQ retries.
      job.stop_reason = SYNC_STOP_REASON.ERROR;
      await this.finish(job, JOB_STATUS.FAILED, (err as Error)?.message ?? 'Sync failed');
      await this.connections.markError(connection.id, (err as Error)?.message ?? 'Sync failed');
      throw err;
    }
  }

  /**
   * Real outbound push (Platform → External). Only runs when the resolved
   * adapter actually declares `capabilities.pushChanges` — for a provider
   * without one (e.g. `custom`), this preserves the exact prior behaviour: an
   * honest, immediately-completed no-op rather than fabricating a push.
   *
   * Mirrors the inbound loop's bounds/cancel/loop-guard, but the "page" here is
   * a bounded scan of internal records changed since the outbound cursor (see
   * `IntegrationUpsertService.listDirtyInternal`) rather than a provider page.
   * A transient per-record failure (network/5xx/429) halts the run at that
   * record WITHOUT advancing the watermark, so a retry re-attempts it; a
   * permanent failure (4xx/validation) is tallied and skipped past — retrying
   * a request the provider will never accept only wastes the next run.
   */
  private async processOutbound(
    job: IntegrationSyncJob,
    connection: IntegrationConnection,
    resource: IntegrationResource,
    tenantId: string,
  ): Promise<void> {
    const canPush = !!this.providers.capabilitiesOf(connection.provider)?.pushChanges;
    if (!canPush) {
      await this.finish(job, JOB_STATUS.COMPLETED, null);
      await this.connections.markSuccess(connection.id);
      return;
    }

    let cursor = job.last_successful_cursor ?? job.cursor ?? null;
    let pages = 0;
    let stop: SyncStopReason = SYNC_STOP_REASON.COMPLETED;
    const deadline = Date.now() + MAX_SYNC_RUNTIME_MS;
    const seenCursors = new Set<string>();

    try {
      outer: while (true) {
        if (pages >= MAX_SYNC_PAGES) { stop = SYNC_STOP_REASON.MAX_PAGES; break; }
        if (job.processed >= MAX_SYNC_RECORDS) { stop = SYNC_STOP_REASON.MAX_RECORDS; break; }
        if (Date.now() > deadline) { stop = SYNC_STOP_REASON.MAX_RUNTIME; break; }

        const fresh = await this.jobs.findOne({ where: { id: job.id }, select: { cancel_requested: true } });
        if (fresh?.cancel_requested) {
          job.stop_reason = SYNC_STOP_REASON.CANCELLED;
          await this.finish(job, JOB_STATUS.CANCELLED, null);
          return;
        }

        const key = cursor ?? ' start';
        if (seenCursors.has(key)) { stop = SYNC_STOP_REASON.REPEATED_CURSOR; break; }
        seenCursors.add(key);

        job.attempted_cursor = cursor;
        const page = await this.upsert.listDirtyInternal(tenantId, resource, cursor, OUTBOUND_SYNC_PAGE_SIZE);
        pages += 1;
        job.pages_fetched = pages;

        if (page.rows.length === 0) { stop = SYNC_STOP_REASON.COMPLETED; break; }

        // ONE record pushed at a time — never the whole page as a single
        // batch. A transient failure must stop the run BEFORE any later row
        // in this page is sent; batching them upfront would already have
        // pushed those later rows over the wire by the time the engine
        // "decides" to stop, making a retry re-push (and, for a create,
        // duplicate) work that already succeeded.
        let stoppedAtRow: string | null = null;
        for (const row of page.rows) {
          job.processed += 1;
          const data = await this.upsert.currentViewOf(tenantId, resource, row.internalId);
          if (!data) {
            // Gone since it was marked dirty — nothing to push; counts as handled.
            this.tally(job, UPSERT_OUTCOME.SKIPPED);
            continue;
          }
          const mapping = await this.idMap.findByInternalId(tenantId, connection.id, resource, row.internalId);
          const record: ProviderPushRecord = { internalId: row.internalId, externalId: mapping?.external_id ?? null, data };

          const pushResult = await this.providers.pushChanges(connection, resource, [record]);
          const result = pushResult.results[0];
          if (!result) {
            // Should not happen (every submitted record gets a result), but never
            // silently treat a missing result as success.
            this.tally(job, UPSERT_OUTCOME.FAILED);
            stoppedAtRow = row.internalId;
            break;
          }
          if (result.ok) {
            const wasCreate = !record.externalId;
            this.tally(job, wasCreate ? UPSERT_OUTCOME.CREATED : UPSERT_OUTCOME.UPDATED);
            if (wasCreate && result.externalId) {
              await this.idMap
                .link(tenantId, connection.id, resource, result.externalId, row.internalId, MAPPING_SOURCE.PLATFORM)
                .catch((e) => this.logger.warn(`outbound mapping link failed for ${row.internalId}: ${(e as Error)?.message}`));
            }
            continue;
          }
          this.tally(job, UPSERT_OUTCOME.FAILED);
          if (result.transient) {
            // Halt exactly here — do not advance past a record that might
            // still succeed on retry.
            stoppedAtRow = row.internalId;
            break;
          }
          // Permanent failure: tallied, skip forward — retrying would never help.
        }

        if (stoppedAtRow) {
          const idx = page.rows.findIndex((r) => r.internalId === stoppedAtRow);
          // Resume from the row BEFORE the one that halted the run — never past it.
          cursor = idx > 0 ? page.rows[idx - 1].cursor : cursor;
          job.cursor = cursor;
          job.last_successful_cursor = cursor;
          await this.jobs.save(job);
          stop = SYNC_STOP_REASON.ITEM_FAILURE;
          break outer;
        }

        cursor = page.rows[page.rows.length - 1].cursor;
        job.cursor = cursor;
        job.last_successful_cursor = cursor;
        await this.jobs.save(job);

        if (!page.hasMore) { stop = SYNC_STOP_REASON.COMPLETED; break; }
      }

      job.stop_reason = stop;
      const clean = job.failed_count === 0 && stop === SYNC_STOP_REASON.COMPLETED;
      const status = clean ? JOB_STATUS.COMPLETED : JOB_STATUS.PARTIALLY_COMPLETED;
      await this.finish(job, status, clean ? null : this.stopSummary(stop, job.failed_count));
      await this.connections.markSuccess(connection.id);
    } catch (err) {
      job.stop_reason = SYNC_STOP_REASON.ERROR;
      await this.finish(job, JOB_STATUS.FAILED, (err as Error)?.message ?? 'Outbound sync failed');
      await this.connections.markError(connection.id, (err as Error)?.message ?? 'Outbound sync failed');
      throw err;
    }
  }

  /** Safe, operator-readable reason a run did not complete cleanly. */
  private stopSummary(stop: SyncStopReason, failed: number): string {
    switch (stop) {
      case SYNC_STOP_REASON.ITEM_FAILURE:
        return `${failed} record(s) failed — the cursor was not advanced; retry to re-process from the same page`;
      case SYNC_STOP_REASON.MAX_PAGES:
        return `Stopped at the ${MAX_SYNC_PAGES}-page limit — retry to continue from the last successful cursor`;
      case SYNC_STOP_REASON.MAX_RECORDS:
        return `Stopped at the ${MAX_SYNC_RECORDS}-record limit — retry to continue from the last successful cursor`;
      case SYNC_STOP_REASON.MAX_RUNTIME:
        return 'Stopped at the runtime limit — retry to continue from the last successful cursor';
      case SYNC_STOP_REASON.REPEATED_CURSOR:
        return 'The provider returned a cursor it had already returned — stopped to avoid an endless loop';
      default:
        return failed > 0 ? 'Some records failed' : 'Run did not complete';
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async finish(job: IntegrationSyncJob, status: string, errorSummary: string | null): Promise<void> {
    job.status = status;
    job.finished_at = new Date();
    if (errorSummary) job.error_summary = errorSummary.slice(0, 500);
    await this.jobs.save(job);
  }

  /** Honours a per-resource direction override (see connections/connection-config.ts), falling back to the connection's own default. */
  private assertDirectionAllowed(connection: IntegrationConnection, resource: IntegrationResource, direction: string): void {
    const configured = this.connections.effectiveDirectionOf(connection, resource);
    if (configured === SYNC_DIRECTION.BIDIRECTIONAL) return;
    if (configured !== direction) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Resource "${resource}" sync direction is "${configured}"; cannot start a ${direction} sync`,
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
      /** Watermark this run STARTED from. */
      cursor: j.cursor ?? null,
      /** Newest boundary REQUESTED (may be ahead of what was safely handled). */
      attemptedCursor: j.attempted_cursor ?? null,
      /** Newest FULLY-handled boundary — the only resume point. */
      lastSuccessfulCursor: j.last_successful_cursor ?? null,
      /** What the provider reports as next. */
      nextCursor: j.next_cursor ?? null,
      cursorKind: j.cursor_kind ?? 'opaque',
      pagesFetched: j.pages_fetched ?? 0,
      stopReason: j.stop_reason ?? null,
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

  /**
   * Recover runs left active by a dead worker (idempotent). NOTE (Phase 0):
   * `start()` no longer risks an enqueue-failure-stuck `pending` row — that
   * path now goes through the transactional outbox. This still matters for a
   * worker that dies mid-`process()` (row already `running`). Scheduled every 2
   * minutes by IntegrationRecoveryProcessor.
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
        .enqueueIntegrationSync({ tenantId: (job.tenant as Tenant)?.id ?? null, syncJobId: job.id })
        .then(() => (requeued += 1))
        .catch(() => undefined);
    }
    return requeued;
  }
}
