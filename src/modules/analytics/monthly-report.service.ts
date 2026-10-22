import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MonthlyReport } from '../../entities/Analytics/MonthlyReport';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { GenerateMonthlyReportDto } from './dto/generate-monthly-report.dto';
import { QueryMonthlyReportsDto } from './dto/query-monthly-reports.dto';
import {
  BatchResult,
  GenerateBatchOptions,
  logBatchFailures,
  mapBranchesSettled,
} from './batch.util';
import { Page, ReportQueryBuilder } from './query/report-query.builder';

/**
 * Monthly reports (`monthly_reports`) — per tenant + branch + month.
 *
 * ALL fields (`total_appointments`, `total_revenue`, `avg_rating`,
 * `top_services`) are computed DIRECTLY FROM SOURCE over the same UTC month
 * window, so the snapshot is internally consistent and never stale w.r.t. daily
 * reports (it no longer silently reads 0 when the month's dailies weren't built).
 * Tenant-scoped; immutable to clients (only `generate` recomputes, via an atomic
 * upsert on the (tenant, branch, period_month) unique key). With no `branchId`,
 * all active branches are generated as a bounded-concurrency batch with
 * partial-failure isolation.
 */
@Injectable()
export class MonthlyReportService {
  private readonly logger = new Logger('MonthlyReportService');

  constructor(
    @InjectRepository(MonthlyReport)
    private readonly reports: Repository<MonthlyReport>,
    private readonly aggregation: AnalyticsAggregationService,
  ) {}

  async generate(
    tenantId: string,
    dto: GenerateMonthlyReportDto,
    options: GenerateBatchOptions = {},
  ): Promise<MonthlyReport | BatchResult<MonthlyReport>> {
    if (dto.branchId) {
      const branch = await this.aggregation.assertBranch(tenantId, dto.branchId);
      return this.generateForBranch(tenantId, branch.id, dto.month);
    }

    const branchIds = await this.aggregation.listActiveBranchIds(tenantId);
    if (branchIds.length === 0) {
      if (options.skipWhenNoActiveBranches) {
        return { generated: [], failed: [], skipped: 'no_active_branches' };
      }
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'No active branches to generate a report for',
      });
    }

    const result = await mapBranchesSettled(branchIds, (branchId) =>
      this.generateForBranch(tenantId, branchId, dto.month),
    );

    logBatchFailures(this.logger, result.failed, `monthly report tenant=${tenantId} month=${dto.month}`);
    return result;
  }

  get(tenantId: string, id: string): Promise<MonthlyReport> {
    return ReportQueryBuilder.scoped(
      this.reports.createQueryBuilder('report'),
      'report',
      tenantId,
    )
      .andWhere('report.id = :id', { id })
      .getOne()
      .then((report) => {
        if (!report) {
          throw new AppError(ErrorCode.NOT_FOUND, { message: 'Monthly report not found' });
        }
        return report;
      });
  }

  list(tenantId: string, query: QueryMonthlyReportsDto): Promise<Page<MonthlyReport>> {
    let qb = ReportQueryBuilder.scoped(
      this.reports.createQueryBuilder('report'),
      'report',
      tenantId,
    );
    qb = ReportQueryBuilder.branch(qb, query.branchId);
    qb = ReportQueryBuilder.month(qb, 'report', query.month);
    return ReportQueryBuilder.page(qb, 'report', 'period_month', query);
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /**
   * Idempotent, concurrency-safe upsert of one branch's monthly report. All
   * fields come from source over the same window; the write is an atomic
   * `INSERT … ON CONFLICT (tenantId, branchId, period_month) DO UPDATE`.
   */
  private async generateForBranch(
    tenantId: string,
    branchId: string,
    month: string,
  ): Promise<MonthlyReport> {
    const [totals, extras] = await Promise.all([
      this.aggregation.computeMonthlyTotals(tenantId, branchId, month),
      this.aggregation.computeMonthlyExtras(tenantId, branchId, month),
    ]);

    await this.reports
      .createQueryBuilder()
      .insert()
      .values({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        period_month: month,
        total_appointments: totals.total_appointments,
        total_revenue: totals.total_revenue,
        avg_rating: extras.avg_rating ?? undefined,
        top_services: extras.top_services as unknown as Record<string, any>,
      })
      .orUpdate(
        ['total_appointments', 'total_revenue', 'avg_rating', 'top_services'],
        ['tenantId', 'branchId', 'period_month'],
      )
      .execute();

    const saved = await this.reports.findOne({
      where: {
        tenant: { id: tenantId },
        branch: { id: branchId },
        period_month: month,
      },
      relations: { branch: true },
    });
    return saved as MonthlyReport;
  }
}
