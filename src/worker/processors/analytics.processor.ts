import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';

import {
  JOB,
  QUEUE,
  SWEEP_FANOUT_PAGE_SIZE,
  workerConcurrency,
} from '../../queue/queue.constants';
import {
  AnalyticsAggregateJob,
  AnalyticsExportGenerateJob,
  AnalyticsGenerateReportJob,
  AnalyticsInvoiceDocumentJob,
} from '../../queue/job-data.interface';
import { validateJobPayload } from '../../queue/job-payload-validator';
import { previousMonthUtc } from '../../modules/analytics/analytics.constants';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { QueueService } from '../../queue/queue.service';
import { WorkerTenantsService } from '../worker-tenants.service';
import { DashboardMetricService } from '../../modules/analytics/dashboard-metric.service';
import { DailyReportService } from '../../modules/analytics/daily-report.service';
import { MonthlyReportService } from '../../modules/analytics/monthly-report.service';
import { AnalyticsRetentionService } from '../../modules/analytics/analytics-retention.service';
import { BatchResult } from '../../modules/analytics/batch.util';
import { InvoiceDocumentService } from '../../modules/payments/invoice-document.service';
import { DocumentRendererService } from '../../modules/documents/document-renderer.service';
import { InvoiceTemplate } from '../../modules/documents/templates/invoice.template';
import { StorageService } from '../../modules/storage/storage.service';
import { ReportExportService } from '../../modules/report-export/report-export.service';

/**
 * Consumes the `analytics` queue. Each job is either a scheduled SWEEP
 * (tenantId null → fan out per active tenant) or PER-TENANT work that reuses the
 * existing analytics services (no recomputation logic is duplicated here).
 */
@Processor(QUEUE.ANALYTICS, { concurrency: workerConcurrency() })
export class AnalyticsProcessor extends WorkerHost {
  private readonly logger = new Logger('AnalyticsProcessor');

  constructor(
    private readonly dashboard: DashboardMetricService,
    private readonly daily: DailyReportService,
    private readonly monthly: MonthlyReportService,
    private readonly retention: AnalyticsRetentionService,
    private readonly tenants: WorkerTenantsService,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
    private readonly invoiceDocuments: InvoiceDocumentService,
    private readonly renderer: DocumentRendererService,
    private readonly storage: StorageService,
    private readonly reportExport: ReportExportService,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === JOB.ANALYTICS_AGGREGATE) {
      const data = job.data as AnalyticsAggregateJob;
      if (!data.tenantId) return this.sweepAggregate();
      return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
        this.dashboard.refresh(data.tenantId!),
      );
    }

    if (job.name === JOB.ANALYTICS_CLEANUP) {
      // Platform-wide retention sweep — no tenant scope.
      return this.retention.purgeExpiredEvents();
    }

    if (job.name === JOB.ANALYTICS_INVOICE_DOCUMENT) {
      const data = job.data as AnalyticsInvoiceDocumentJob;
      return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
        this.renderInvoiceDocument(data),
      );
    }

    // T183 (spec 014, US13) — explicit branch ahead of T095's unknown-job
    // guard below, exactly as that task's own trap note requires: a job
    // name that reaches this processor MUST name its own branch or be
    // rejected loudly, never silently fall through to report generation.
    if (job.name === JOB.ANALYTICS_EXPORT_GENERATE) {
      const data = job.data as AnalyticsExportGenerateJob;
      validateJobPayload(job.name, data);
      return runInTenantContext(this.ctx, this.authz, job.name, data, () =>
        this.reportExport.generateExport(data.tenantId, data.exportJobId),
      );
    }

    // T095 — every branch above names its own job; anything else is treated
    // as `analytics.generateReport` below by DEFAULT. A future job name
    // added without its own branch must fail loudly here instead of
    // silently running report generation against a mismatched payload.
    if (job.name !== JOB.ANALYTICS_GENERATE_REPORT) {
      throw new UnrecoverableError(
        `AnalyticsProcessor: unknown job name "${job.name}" — refusing to fall through to report generation`,
      );
    }

    const data = job.data as AnalyticsGenerateReportJob;
    if (!data.tenantId) {
      return data.kind === 'monthly'
        ? this.sweepMonthlyReports(data)
        : this.sweepReports(data);
    }
    return runInTenantContext<unknown>(
      this.ctx,
      this.authz,
      job.name,
      data,
      async () => {
        // Per-tenant report jobs only come from the scheduled sweeps, which
        // fan out to every active tenant — a clinic with no active branch has
        // nothing to report, so that is a recorded skip, not a failure.
        const options = { skipWhenNoActiveBranches: true };
        const result =
          data.kind === 'monthly'
            ? await this.monthly.generate(
                data.tenantId!,
                { month: data.month!, branchId: data.branchId },
                options,
              )
            : await this.daily.generate(
                data.tenantId!,
                { date: data.date!, branchId: data.branchId },
                options,
              );
        if ((result as BatchResult<unknown>).skipped) {
          this.logger.log(
            `analytics.generateReport ${data.kind ?? 'daily'} tenant=${data.tenantId} skipped: no active branches`,
          );
        }
        return result;
      },
    );
  }

  /**
   * T095 (spec 014, US12, R2, FR-I012, FR-I013) — the ONE place PDF
   * rendering is allowed to run (`DocumentRendererService` throws if
   * constructed outside the worker process). Idempotent on `(invoiceId,
   * documentVersion)`: `enqueueAnalyticsInvoiceDocument`'s deterministic
   * jobId already collapses a redelivered job for the SAME version into one
   * BullMQ job; `markRendered`'s version guard additionally stops a late
   * redelivery of an OLD version from regressing a newer already-rendered
   * one.
   */
  private async renderInvoiceDocument(
    data: AnalyticsInvoiceDocumentJob,
  ): Promise<{ documentKey: string }> {
    const documentData = await this.invoiceDocuments.buildDocumentData(
      data.tenantId,
      data.invoiceId,
    );
    const locale = await this.invoiceDocuments.localeFor(data.tenantId);
    const buffer = await this.renderer.render(
      new InvoiceTemplate(),
      documentData,
      locale,
    );
    const stored = await this.storage.upload({
      tenantId: data.tenantId,
      docType: 'invoices',
      originalName: `${documentData.invoiceNumber}.pdf`,
      mimeType: 'application/pdf',
      size: buffer.length,
      buffer,
    });
    await this.invoiceDocuments.markRendered(
      data.tenantId,
      data.invoiceId,
      data.documentVersion,
      stored.storageKey,
    );
    return { documentKey: stored.storageKey };
  }

  /**
   * Pages through active tenants (M7 — docs/CACHING_QUEUES_AUDIT.md) instead
   * of loading all of them in one unbounded query, and `addBulk`s each page
   * in one round trip instead of one `add()` per tenant — bounded DB reads
   * and Redis round trips regardless of tenant count.
   */
  private async sweepAggregate() {
    let offset = 0;
    let fannedOut = 0;
    for (;;) {
      const page = await this.tenants.activeTenantIdsPage(
        offset,
        SWEEP_FANOUT_PAGE_SIZE,
      );
      if (page.length === 0) break;
      await this.queue.enqueueAnalyticsAggregateBulk(page);
      fannedOut += page.length;
      offset += page.length;
      if (page.length < SWEEP_FANOUT_PAGE_SIZE) break;
    }
    this.logger.log(
      `analytics.aggregate sweep fanned out ${fannedOut} tenant(s)`,
    );
    return { fannedOut };
  }

  private async sweepReports(template: AnalyticsGenerateReportJob) {
    // The report DAY is the clinic's local calendar day (generation measures
    // it in the clinic's reporting timezone). The tick fires at 00:30 UTC, when
    // "yesterday in UTC" has fully ended for every clinic at or ahead of UTC
    // (all current clinics: UTC / Asia/Riyadh). A clinic BEHIND UTC would have
    // its day still open at this tick and need a later tick or a manual
    // regenerate — documented, not handled, since none exists today.
    const date =
      template.date ??
      new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    let offset = 0;
    let fannedOut = 0;
    for (;;) {
      const page = await this.tenants.activeTenantIdsPage(
        offset,
        SWEEP_FANOUT_PAGE_SIZE,
      );
      if (page.length === 0) break;
      await this.queue.enqueueAnalyticsReportBulk(
        page.map((tenantId) => ({ tenantId, date })),
      );
      fannedOut += page.length;
      offset += page.length;
      if (page.length < SWEEP_FANOUT_PAGE_SIZE) break;
    }
    this.logger.log(
      `analytics.generateReport sweep (${date}) fanned out ${fannedOut} tenant(s)`,
    );
    return { fannedOut, date };
  }

  /**
   * Monthly sweep (FND-014). Targets the month that just completed in UTC —
   * the tick fires shortly after month rollover (see ScheduleRegistrarService)
   * — unless a month is given explicitly (a manual re-trigger reusing this
   * same sweep path). Same bounded-paging/bulk-enqueue shape as sweepReports;
   * duplicate generation for a month is prevented twice over: the deterministic
   * per-(tenant,month) jobId here, and MonthlyReportService's own DB-level
   * (tenant, branch, period_month) unique upsert on the RUN side.
   */
  private async sweepMonthlyReports(template: AnalyticsGenerateReportJob) {
    const month = template.month ?? previousMonthUtc(new Date());
    let offset = 0;
    let fannedOut = 0;
    for (;;) {
      const page = await this.tenants.activeTenantIdsPage(
        offset,
        SWEEP_FANOUT_PAGE_SIZE,
      );
      if (page.length === 0) break;
      await this.queue.enqueueAnalyticsReportMonthlyBulk(
        page.map((tenantId) => ({ tenantId, month })),
      );
      fannedOut += page.length;
      offset += page.length;
      if (page.length < SWEEP_FANOUT_PAGE_SIZE) break;
    }
    this.logger.log(
      `analytics.generateReport monthly sweep (${month}) fanned out ${fannedOut} tenant(s)`,
    );
    return { fannedOut, month };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // Logged at error by the job wrapper (common/logging/job-instrumentation.ts).
    this.logger.debug(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
