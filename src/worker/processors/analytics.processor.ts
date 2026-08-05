import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import {
  JOB,
  QUEUE,
  SWEEP_FANOUT_PAGE_SIZE,
  workerConcurrency,
} from '../../queue/queue.constants';
import {
  AnalyticsAggregateJob,
  AnalyticsGenerateReportJob,
} from '../../queue/job-data.interface';
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

    // analytics.generateReport
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
        if (data.kind === 'monthly') {
          return this.monthly.generate(data.tenantId!, {
            month: data.month!,
            branchId: data.branchId,
          });
        }
        return this.daily.generate(data.tenantId!, {
          date: data.date!,
          branchId: data.branchId,
        });
      },
    );
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
    this.logger.error(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
