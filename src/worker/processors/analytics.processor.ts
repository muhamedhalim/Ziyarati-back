import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import {
  AnalyticsAggregateJob,
  AnalyticsGenerateReportJob,
} from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { QueueService } from '../../queue/queue.service';
import { WorkerTenantsService } from '../worker-tenants.service';
import { DashboardMetricService } from '../../modules/analytics/dashboard-metric.service';
import { DailyReportService } from '../../modules/analytics/daily-report.service';
import { MonthlyReportService } from '../../modules/analytics/monthly-report.service';

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
    private readonly tenants: WorkerTenantsService,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === JOB.ANALYTICS_AGGREGATE) {
      const data = job.data as AnalyticsAggregateJob;
      if (!data.tenantId) return this.sweepAggregate();
      return runInTenantContext(this.ctx, data, () => this.dashboard.refresh(data.tenantId!));
    }

    // analytics.generateReport
    const data = job.data as AnalyticsGenerateReportJob;
    if (!data.tenantId) return this.sweepReports(data);
    return runInTenantContext<unknown>(this.ctx, data, async () => {
      if (data.kind === 'monthly') {
        return this.monthly.generate(data.tenantId!, { month: data.month!, branchId: data.branchId });
      }
      return this.daily.generate(data.tenantId!, { date: data.date!, branchId: data.branchId });
    });
  }

  private async sweepAggregate() {
    const ids = await this.tenants.activeTenantIds();
    for (const tenantId of ids) {
      await this.queue.enqueueAnalyticsAggregate({ tenantId });
    }
    this.logger.log(`analytics.aggregate sweep fanned out ${ids.length} tenant(s)`);
    return { fannedOut: ids.length };
  }

  private async sweepReports(template: AnalyticsGenerateReportJob) {
    const date = template.date ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const ids = await this.tenants.activeTenantIds();
    for (const tenantId of ids) {
      await this.queue.enqueueAnalyticsReport({ tenantId, kind: 'daily', date });
    }
    this.logger.log(`analytics.generateReport sweep (${date}) fanned out ${ids.length} tenant(s)`);
    return { fannedOut: ids.length, date };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
