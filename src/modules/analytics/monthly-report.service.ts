import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MonthlyReport } from '../../entities/Analytics/MonthlyReport';
import { DailyReport } from '../../entities/Analytics/DailyReport';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { GenerateMonthlyReportDto } from './dto/generate-monthly-report.dto';
import { QueryMonthlyReportsDto } from './dto/query-monthly-reports.dto';
import { monthDateBounds, round2 } from './analytics.constants';
import { BatchResult, mapBranchesSettled } from './batch.util';
import { Page, ReportQueryBuilder } from './query/report-query.builder';

/**
 * Monthly reports (`monthly_reports`) — per tenant + branch + month.
 *
 * Totals (`total_appointments`, `total_revenue`) are aggregated IN SQL from that
 * month's DailyReports (`SUM(...)`, not an in-memory `reduce`); `avg_rating` and
 * `top_services` are computed from source via the aggregation service.
 * Tenant-scoped; immutable to clients (only `generate` recomputes, upserting on
 * the (tenant, branch, period_month) unique key). With no `branchId`, all active
 * branches are generated as a bounded-concurrency batch with partial-failure
 * isolation.
 */
@Injectable()
export class MonthlyReportService {
  private readonly logger = new Logger('MonthlyReportService');

  constructor(
    @InjectRepository(MonthlyReport)
    private readonly reports: Repository<MonthlyReport>,
    @InjectRepository(DailyReport)
    private readonly dailyReports: Repository<DailyReport>,
    private readonly aggregation: AnalyticsAggregationService,
  ) {}

  async generate(
    tenantId: string,
    dto: GenerateMonthlyReportDto,
  ): Promise<MonthlyReport | BatchResult<MonthlyReport>> {
    if (dto.branchId) {
      const branch = await this.aggregation.assertBranch(tenantId, dto.branchId);
      return this.generateForBranch(tenantId, branch.id, dto.month);
    }

    const branchIds = await this.aggregation.listActiveBranchIds(tenantId);
    if (branchIds.length === 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'No active branches to generate a report for',
      });
    }

    const result = await mapBranchesSettled(branchIds, (branchId) =>
      this.generateForBranch(tenantId, branchId, dto.month),
    );

    for (const f of result.failed) {
      this.logger.error(
        `monthly report failed tenant=${tenantId} branch=${f.branchId} month=${dto.month}: ${f.error}`,
      );
    }
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

  private async generateForBranch(
    tenantId: string,
    branchId: string,
    month: string,
  ): Promise<MonthlyReport> {
    // Totals summed from the month's daily reports IN SQL (no in-memory reduce).
    const totals = await this.sumDailyTotals(tenantId, branchId, month);

    // Rating + top services come from source (not stored on daily reports).
    const extras = await this.aggregation.computeMonthlyExtras(
      tenantId,
      branchId,
      month,
    );

    let report = await this.reports.findOne({
      where: {
        tenant: { id: tenantId },
        branch: { id: branchId },
        period_month: month,
      },
    });
    if (!report) {
      report = this.reports.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        period_month: month,
      });
    }

    report.total_appointments = totals.total_appointments;
    report.total_revenue = totals.total_revenue;
    report.avg_rating = extras.avg_rating ?? undefined;
    report.top_services = extras.top_services as unknown as Record<string, any>;

    return this.reports.save(report);
  }

  /**
   * `SUM()` the month's daily-report totals in the database — one aggregate
   * round-trip that returns no rows to the app, instead of fetching every daily
   * row and reducing in memory.
   */
  private async sumDailyTotals(
    tenantId: string,
    branchId: string,
    month: string,
  ): Promise<{ total_appointments: number; total_revenue: number }> {
    const { firstDay, lastDay } = monthDateBounds(month);
    const row = await this.dailyReports
      .createQueryBuilder('d')
      .innerJoin('d.tenant', 't')
      .innerJoin('d.branch', 'b')
      .select('COALESCE(SUM(d.total_appointments), 0)', 'appointments')
      .addSelect('COALESCE(SUM(d.total_revenue), 0)', 'revenue')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('b.id = :branchId', { branchId })
      .andWhere('d.date BETWEEN :firstDay AND :lastDay', { firstDay, lastDay })
      .getRawOne<{ appointments: string; revenue: string }>();

    return {
      total_appointments: Number(row?.appointments ?? 0),
      total_revenue: round2(Number(row?.revenue ?? 0)),
    };
  }
}
