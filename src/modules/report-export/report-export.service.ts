import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';

import { ExportJob } from '../../entities/System/ExportJob';
import { ExportJobFormat, ExportJobState } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { REPORT_EXPORT_UPLOAD_POLICY } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { QueueService } from '../../queue/queue.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

import { AdvancedAnalyticsService } from '../analytics/advanced-analytics.service';
import { DailyReportService } from '../analytics/daily-report.service';
import { MonthlyReportService } from '../analytics/monthly-report.service';
import { StaffPerformanceService } from '../analytics/staff-performance.service';
import { AnalyticsAggregationService } from '../analytics/analytics-aggregation.service';

import {
  ExportRegistryEntry,
  ExportRunContext,
  extractRows,
  getExportRegistryEntry,
  isExportableReportKey,
  ReportKey,
  SourceRow,
} from './export-registry';
import { FetchExportPage, XlsxWriterService } from './xlsx-writer.service';
import { ReportExportAuditService } from './report-export-audit.service';
import {
  exportConcurrencyCapPerTenant,
  exportRetentionDays,
  exportSyncRowThreshold,
} from './report-export.constants';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface CreateExportInput {
  report: string;
  format?: 'XLSX' | 'PDF';
  filters?: Record<string, unknown>;
}

export type ExportRequestResult =
  | { kind: 'sync'; buffer: Buffer; filename: string; contentType: string }
  | { kind: 'async'; jobId: string };

export interface ExportStatusView {
  state: ExportJobState;
  rowCount?: number;
  error?: string;
  expiresAt?: Date;
}

/**
 * Spec 014 (Clinic Platform Completion) — T181 (US13, FR-X001/FR-X002/
 * FR-X004). Resolves a registry entry (T180), applies the requester's
 * filters and CAPTURED branch scope, and either streams the result back
 * synchronously (below `exportSyncRowThreshold`) or hands it to the
 * `analytics.exportGenerate` queue (T183) above it.
 *
 * SECURITY (frozen scope, T179's own note): `branch_scope` is resolved
 * ONCE, here, at request time (`AdvancedAnalyticsService.resolveScope` —
 * FR-A016's existing branch-restriction logic, reused verbatim). Generation
 * — both the synchronous path in this method and the background path in
 * `generateExport` — reads ONLY the captured `ctx.branchScope`/`filters`
 * afterward; neither ever re-resolves the CURRENT caller's scope. A
 * permission change after the request (e.g. a branch-restricted user's
 * scope narrowing) therefore cannot widen an export already in flight.
 *
 * "Do not duplicate any report calculation" (FR-X002): `buildFetchPage`
 * invokes `entry.query` — the literal existing service method — via
 * `Function.prototype.apply` against the real injected instance. No branch
 * of this service recomputes a count, a sum, or any other report figure.
 */
@Injectable()
export class ReportExportService {
  private readonly logger = new Logger(ReportExportService.name);

  constructor(
    @InjectRepository(ExportJob)
    private readonly exportJobs: Repository<ExportJob>,
    private readonly advanced: AdvancedAnalyticsService,
    private readonly daily: DailyReportService,
    private readonly monthly: MonthlyReportService,
    private readonly staffPerformance: StaffPerformanceService,
    private readonly aggregation: AnalyticsAggregationService,
    private readonly xlsx: XlsxWriterService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly audit: ReportExportAuditService,
  ) {}

  /** Which injected instance owns each registry entry's literal `query` method. */
  private instanceFor(key: ReportKey): object {
    switch (key) {
      case 'daily-report':
        return this.daily;
      case 'monthly-report':
        return this.monthly;
      case 'staff-performance':
        return this.staffPerformance;
      case 'service-performance':
      case 'branch-performance':
      case 'channel-performance':
        return this.aggregation;
    }
  }

  // ─────────────────────────── Request (T181/T184) ──────────────────────── //

  async requestExport(
    tenantId: string,
    user: AuthenticatedUser,
    input: CreateExportInput,
  ): Promise<ExportRequestResult> {
    const { entry, format, filters } = await this.validateRequest(input);

    const requestedBranchId =
      typeof filters.branchId === 'string' ? filters.branchId : undefined;
    const scope = await this.advanced.resolveScope(
      tenantId,
      user,
      requestedBranchId,
    );
    const branchScope = scope.branchId ? { branchId: scope.branchId } : null;

    const ctx: ExportRunContext = { tenantId, branchScope, filters };
    const instance = this.instanceFor(entry.key);
    const probeSize = exportSyncRowThreshold() + 1;
    const fetchPage = this.buildFetchPage(entry, ctx, instance);

    // Peek at up to (threshold + 1) rows to decide sync vs. background —
    // never fetches more than one probe page's worth up front.
    const probe = await fetchPage(null, probeSize);
    const fitsSync =
      probe.nextCursor === null &&
      probe.rows.length <= exportSyncRowThreshold();

    if (fitsSync) {
      const auditId = randomUUID();
      await this.audit.recordRequested(
        tenantId,
        auditId,
        entry.key,
        filters,
        user.id,
      );
      const alreadyFetched: FetchExportPage = (() => {
        let served = false;
        return async () => {
          if (served) return { rows: [], nextCursor: null };
          served = true;
          return probe;
        };
      })();
      const { buffer, rowCount } = await this.xlsx.writeToBuffer(
        entry.columns,
        alreadyFetched,
      );
      await this.audit.recordCompleted(
        tenantId,
        auditId,
        entry.key,
        filters,
        rowCount,
        user.id,
      );
      return {
        kind: 'sync',
        buffer,
        filename: `${entry.key}.xlsx`,
        contentType: XLSX_MIME,
      };
    }

    const job = await this.exportJobs.save(
      this.exportJobs.create({
        tenant: { id: tenantId } as ExportJob['tenant'],
        requestedBy: { id: user.id } as ExportJob['requestedBy'],
        report: entry.key,
        format: format as ExportJobFormat,
        filters,
        branch_scope: branchScope,
        state: ExportJobState.PENDING,
      }),
    );
    await this.audit.recordRequested(
      tenantId,
      job.id,
      entry.key,
      filters,
      user.id,
    );
    await this.queue.enqueueAnalyticsExportGenerate({
      tenantId,
      actorId: user.id,
      exportJobId: job.id,
    });
    return { kind: 'async', jobId: job.id };
  }

  private async validateRequest(input: CreateExportInput): Promise<{
    entry: ExportRegistryEntry;
    format: 'XLSX' | 'PDF';
    filters: Record<string, unknown>;
  }> {
    if (!input.report || !isExportableReportKey(input.report)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Unknown report key',
      });
    }
    const entry = getExportRegistryEntry(input.report);
    const format = input.format ?? 'XLSX';
    if (!entry.formats.includes(format)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Report "${entry.key}" does not support the "${format}" format`,
      });
    }

    const filtersInstance = plainToInstance(entry.argsDto, input.filters ?? {});
    const errors = await validate(filtersInstance, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });
    if (errors.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Invalid export filters',
        publicContext: {
          fields: errors.map((e) => e.property),
        },
      });
    }

    return {
      entry,
      format,
      filters: JSON.parse(JSON.stringify(filtersInstance)) as Record<
        string,
        unknown
      >,
    };
  }

  // ─────────────────────────── Status / download (T184) ─────────────────── //

  async getStatus(tenantId: string, jobId: string): Promise<ExportStatusView> {
    const job = await this.findOwnedJob(tenantId, jobId);
    return {
      state: job.state,
      rowCount: job.row_count ?? undefined,
      error: job.error ?? undefined,
      expiresAt: job.expires_at ?? undefined,
    };
  }

  /**
   * Returns a signed download URL for a READY job. Throws:
   *  - `NOT_FOUND` for an unknown OR cross-tenant job id (FR-X011) —
   *    byte-identical, no enumeration.
   *  - `CONFLICT` with `publicContext.state` for `EXPIRED`/`FAILED` — a
   *    valid, tenant-owned job id whose file is simply not downloadable
   *    right now, per the token-state rule (contracts/public-surfaces.md).
   *  - Returns `{ pending: true, state }` for `PENDING`/`RUNNING` — the
   *    caller polls `GET /reports/export/:jobId` instead of erroring.
   */
  async getDownload(
    tenantId: string,
    jobId: string,
  ): Promise<
    { pending: true; state: ExportJobState } | { pending: false; url: string }
  > {
    const job = await this.findOwnedJob(tenantId, jobId);

    if (
      job.state === ExportJobState.PENDING ||
      job.state === ExportJobState.RUNNING
    ) {
      return { pending: true, state: job.state };
    }
    if (job.state === ExportJobState.EXPIRED) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This export has expired and is no longer downloadable',
        publicContext: { state: ExportJobState.EXPIRED },
      });
    }
    if (job.state === ExportJobState.FAILED) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This export failed to generate',
        publicContext: { state: ExportJobState.FAILED },
      });
    }
    if (!job.storage_key) {
      // READY with no storage_key would be a data-integrity bug, never a
      // caller-triggerable state — fail loudly rather than serve a broken link.
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message: 'Export marked ready but has no stored file',
      });
    }
    const url = await this.storage.getSignedDownloadUrl(
      job.storage_key,
      tenantId,
    );
    return { pending: false, url };
  }

  private async findOwnedJob(
    tenantId: string,
    jobId: string,
  ): Promise<ExportJob> {
    const job = await this.exportJobs.findOne({
      where: { id: jobId, tenant: { id: tenantId } },
    });
    if (!job) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Export job not found',
      });
    }
    return job;
  }

  // ─────────────────────────── Background generation (T183) ─────────────── //

  /**
   * Claims and generates one export job. Called ONLY from
   * `AnalyticsProcessor`'s `analytics.exportGenerate` branch (T183).
   *
   * `claim()` is a single conditional UPDATE — `PENDING → RUNNING` gated on
   * BOTH the row's own state AND a live count of the tenant's currently
   * RUNNING jobs staying under the concurrency cap — so two workers can
   * never both claim the same job, and one tenant can never monopolise the
   * export worker pool. Returns `'cap-reached'` (a RETRYABLE condition —
   * the caller should let BullMQ's normal backoff retry it) separately from
   * `'already-handled'` (the job moved on without this worker's help;
   * nothing to do).
   */
  async generateExport(tenantId: string, exportJobId: string): Promise<void> {
    const claim = await this.claim(tenantId, exportJobId);
    if (claim === 'already-handled') return;
    if (claim === 'cap-reached') {
      throw new Error(
        `export ${exportJobId}: per-tenant concurrency cap reached — will retry`,
      );
    }

    const job = await this.exportJobs.findOneOrFail({
      where: { id: exportJobId, tenant: { id: tenantId } },
    });

    try {
      const entry = getExportRegistryEntry(job.report as ReportKey);
      const ctx: ExportRunContext = {
        tenantId,
        branchScope: job.branch_scope,
        filters: job.filters,
      };
      const instance = this.instanceFor(entry.key);
      const fetchPage = this.buildFetchPage(entry, ctx, instance);
      const { buffer, rowCount } = await this.xlsx.writeToBuffer(
        entry.columns,
        fetchPage,
      );

      const stored = await this.storage.upload(
        {
          tenantId,
          docType: 'exports',
          originalName: `${entry.key}.xlsx`,
          mimeType: XLSX_MIME,
          size: buffer.length,
          buffer,
        },
        REPORT_EXPORT_UPLOAD_POLICY,
      );

      const expiresAt = new Date(
        Date.now() + exportRetentionDays() * 86_400_000,
      );
      await this.exportJobs.update(
        { id: exportJobId },
        {
          state: ExportJobState.READY,
          storage_key: stored.storageKey,
          row_count: rowCount,
          expires_at: expiresAt,
        },
      );
      await this.audit.recordCompleted(
        tenantId,
        exportJobId,
        job.report,
        job.filters,
        rowCount,
        job.requestedBy?.id,
      );
    } catch (err) {
      const message = (err as Error)?.message ?? 'Export generation failed';
      this.logger.error(`export ${exportJobId} failed: ${message}`);
      await this.exportJobs.update(
        { id: exportJobId },
        { state: ExportJobState.FAILED, error: message.slice(0, 500) },
      );
      throw err;
    }
  }

  /**
   * Atomic conditional claim (M5-style discipline, mirrors this codebase's
   * established `PENDING → RUNNING` conditional-update convention — never a
   * read-then-save race). The concurrency cap is enforced in the SAME
   * statement via a correlated subquery: accepted as a small, bounded race
   * window (two claims for the SAME tenant landing in the exact same
   * instant could momentarily exceed the cap by one) rather than a strict
   * invariant — FR-X014 asks that export work "cannot starve other clinic
   * operations", a soft fairness bound, not a hard uniqueness constraint
   * like double-booking a slot.
   */
  private async claim(
    tenantId: string,
    exportJobId: string,
  ): Promise<'claimed' | 'already-handled' | 'cap-reached'> {
    const cap = exportConcurrencyCapPerTenant();
    const result = await this.exportJobs.query(
      `UPDATE export_jobs
       SET state = 'RUNNING', updated_at = now()
       WHERE id = $1
         AND "tenantId" = $2
         AND state = 'PENDING'
         AND (SELECT COUNT(*) FROM export_jobs WHERE "tenantId" = $2 AND state = 'RUNNING') < $3
       RETURNING id`,
      [exportJobId, tenantId, cap],
    );
    if (Array.isArray(result) && result.length > 0) return 'claimed';

    const current = await this.exportJobs.findOne({
      where: { id: exportJobId, tenant: { id: tenantId } },
    });
    if (!current || current.state !== ExportJobState.PENDING) {
      return 'already-handled';
    }
    return 'cap-reached';
  }

  // ─────────────────────────── Expiry sweep (T183) ───────────────────────── //

  /** Paging width for the expiry sweep — bounded, mirrors the other sweeps' page-and-repeat shape. */
  private static readonly EXPIRY_SWEEP_PAGE_SIZE = 200;

  /**
   * Called ONLY from `PlatformProcessor`'s `platform.exportExpiry` branch,
   * itself lock-guarded and heartbeat-emitting exactly like
   * `processWaitlistExpiry` (T160) — this method holds no lock of its own.
   *
   * FR-X010 / security note (T183): the storage object is deleted BEFORE
   * the row flips to `EXPIRED` — an `EXPIRED` job must never point at
   * retrievable bytes. If the delete throws, the row is left `READY`
   * (unchanged) rather than marked `EXPIRED` with a dangling object; the
   * next sweep run retries it.
   */
  async expireDueExports(): Promise<{ expired: number }> {
    let expired = 0;
    for (;;) {
      const due = await this.exportJobs.find({
        where: { state: ExportJobState.READY },
        relations: { tenant: true },
        order: { expires_at: 'ASC' },
        take: ReportExportService.EXPIRY_SWEEP_PAGE_SIZE,
      });
      const dueNow = due.filter(
        (j) => j.expires_at && j.expires_at.getTime() <= Date.now(),
      );
      if (dueNow.length === 0) break;

      for (const job of dueNow) {
        try {
          if (job.storage_key) {
            await this.storage.deleteObject(job.storage_key, job.tenant.id);
          }
          await this.exportJobs.update(
            { id: job.id },
            { state: ExportJobState.EXPIRED },
          );
          expired++;
        } catch (err) {
          this.logger.error(
            `export ${job.id} expiry failed (object left in place, will retry): ${(err as Error)?.message}`,
          );
        }
      }
      if (dueNow.length < due.length) break; // remaining rows in this page aren't due yet
      if (due.length < ReportExportService.EXPIRY_SWEEP_PAGE_SIZE) break;
    }
    return { expired };
  }

  // ─────────────────────────── Shared page-fetching ──────────────────────── //

  /**
   * Builds the KEYSET-style page fetcher `XlsxWriterService` streams from.
   *
   * `entry.paginated` entries (daily/monthly reports) page by literally
   * re-invoking `entry.query` with an incrementing `page` — the SAME
   * offset-based pagination `DailyReportService.list`/`MonthlyReportService.list`
   * already expose to their own HTTP routes; nothing here reimplements
   * pagination, it drives the existing one further.
   *
   * Non-paginated entries (the four bounded-cardinality aggregation
   * queries) are fetched ONCE — their result size is bounded by catalogue
   * cardinality (staff/branch/service/channel count), never by the volume
   * of underlying events, so a single page is both correct and
   * memory-safe — and returned as a single page.
   */
  private buildFetchPage(
    entry: ExportRegistryEntry,
    ctx: ExportRunContext,
    instance: object,
  ): FetchExportPage {
    if (entry.paginated) {
      return async (cursor, pageSize) => {
        const page = cursor ? Number(cursor) : 1;
        const args = entry.toArgs({
          ...ctx,
          filters: { ...ctx.filters, page, limit: pageSize },
        });

        const result = (await (entry.query as any).apply(instance, args)) as
          | SourceRow[]
          | { data: SourceRow[] };
        const data = extractRows(result);
        const total =
          (result as { total?: number })?.total ??
          (page - 1) * pageSize + data.length;
        const fetchedSoFar = (page - 1) * pageSize + data.length;
        const nextCursor =
          data.length === pageSize && fetchedSoFar < total
            ? String(page + 1)
            : null;
        return {
          rows: data.map((row) => entry.serializeRow(row)),
          nextCursor,
        };
      };
    }

    let fetched = false;
    return async () => {
      if (fetched) return { rows: [], nextCursor: null };
      fetched = true;
      const args = entry.toArgs(ctx);

      const result = (await (entry.query as any).apply(instance, args)) as
        | SourceRow[]
        | { data: SourceRow[] };
      const data = extractRows(result);
      return {
        rows: data.map((row) => entry.serializeRow(row)),
        nextCursor: null,
      };
    };
  }
}
