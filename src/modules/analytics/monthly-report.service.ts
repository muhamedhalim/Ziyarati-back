import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, Repository } from 'typeorm';

import { MonthlyReport } from '../../entities/Analytics/MonthlyReport';
import { DailyReport } from '../../entities/Analytics/DailyReport';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { GenerateMonthlyReportDto } from './dto/generate-monthly-report.dto';
import { QueryMonthlyReportsDto } from './dto/query-monthly-reports.dto';
import { monthDateBounds, round2 } from './analytics.constants';

/**
 * Monthly reports (`monthly_reports`) — per tenant + branch + month.
 *
 * Totals (`total_appointments`, `total_revenue`) are aggregated from that month's
 * DailyReports; `avg_rating` and `top_services` are computed from source via the
 * aggregation service. Tenant-scoped; immutable to clients (only `generate`
 * recomputes, upserting on the (tenant, branch, period_month) unique key). With
 * no `branchId`, all active branches are generated in one batch.
 */
@Injectable()
export class MonthlyReportService {
  constructor(
    @InjectRepository(MonthlyReport)
    private readonly reports: Repository<MonthlyReport>,
    @InjectRepository(DailyReport)
    private readonly dailyReports: Repository<DailyReport>,
    private readonly aggregation: AnalyticsAggregationService,
  ) {}

  async generate(tenantId: string, dto: GenerateMonthlyReportDto) {
    const branchIds = dto.branchId
      ? [(await this.aggregation.assertBranch(tenantId, dto.branchId)).id]
      : await this.aggregation.listActiveBranchIds(tenantId);

    if (branchIds.length === 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'No active branches to generate a report for',
      });
    }

    const results: MonthlyReport[] = [];
    for (const branchId of branchIds) {
      results.push(await this.generateForBranch(tenantId, branchId, dto.month));
    }
    return dto.branchId ? results[0] : results;
  }

  async get(tenantId: string, id: string): Promise<MonthlyReport> {
    const report = await this.reports.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { branch: true },
    });
    if (!report) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Monthly report not found' });
    }
    return report;
  }

  async list(tenantId: string, query: QueryMonthlyReportsDto) {
    const where: FindOptionsWhere<MonthlyReport> = { tenant: { id: tenantId } };
    if (query.branchId) where.branch = { id: query.branchId };
    if (query.month) where.period_month = query.month;

    const [data, total] = await this.reports.findAndCount({
      where,
      relations: { branch: true },
      order: { period_month: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async generateForBranch(
    tenantId: string,
    branchId: string,
    month: string,
  ): Promise<MonthlyReport> {
    const { firstDay, lastDay } = monthDateBounds(month);

    // Totals are summed from the month's daily reports (aggregated-from-daily).
    const dailies = await this.dailyReports.find({
      where: {
        tenant: { id: tenantId },
        branch: { id: branchId },
        date: Between(firstDay, lastDay) as any,
      },
    });
    const total_appointments = dailies.reduce(
      (sum, d) => sum + Number(d.total_appointments),
      0,
    );
    const total_revenue = round2(
      dailies.reduce((sum, d) => sum + Number(d.total_revenue), 0),
    );

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

    report.total_appointments = total_appointments;
    report.total_revenue = total_revenue;
    report.avg_rating = extras.avg_rating ?? undefined;
    report.top_services = extras.top_services as any;

    return this.reports.save(report);
  }
}
