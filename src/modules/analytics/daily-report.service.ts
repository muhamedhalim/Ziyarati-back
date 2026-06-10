import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { DailyReport } from '../../entities/Analytics/DailyReport';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { GenerateDailyReportDto } from './dto/generate-daily-report.dto';
import { QueryDailyReportsDto } from './dto/query-daily-reports.dto';

/**
 * Daily reports (`daily_reports`) — pre-aggregated, per tenant + branch + day.
 *
 * Tenant-scoped via the `tenant` relation. Reports are immutable to clients (no
 * update endpoint); `generate` performs the only allowed write — a system
 * (re)computation that upserts on the (tenant, branch, date) unique key. With no
 * `branchId`, all active branches are generated in one batch.
 */
@Injectable()
export class DailyReportService {
  constructor(
    @InjectRepository(DailyReport)
    private readonly reports: Repository<DailyReport>,
    private readonly aggregation: AnalyticsAggregationService,
  ) {}

  async generate(tenantId: string, dto: GenerateDailyReportDto) {
    const branchIds = dto.branchId
      ? [(await this.aggregation.assertBranch(tenantId, dto.branchId)).id]
      : await this.aggregation.listActiveBranchIds(tenantId);

    if (branchIds.length === 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'No active branches to generate a report for',
      });
    }

    const results: DailyReport[] = [];
    for (const branchId of branchIds) {
      results.push(await this.generateForBranch(tenantId, branchId, dto.date));
    }
    return dto.branchId ? results[0] : results;
  }

  async get(tenantId: string, id: string): Promise<DailyReport> {
    const report = await this.reports.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { branch: true },
    });
    if (!report) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Daily report not found' });
    }
    return report;
  }

  async list(tenantId: string, query: QueryDailyReportsDto) {
    const where: FindOptionsWhere<DailyReport> = { tenant: { id: tenantId } };
    if (query.branchId) where.branch = { id: query.branchId };
    if (query.from && query.to) {
      where.date = Between(query.from, query.to) as any;
    } else if (query.from) {
      where.date = MoreThanOrEqual(query.from) as any;
    } else if (query.to) {
      where.date = LessThan(query.to) as any;
    }

    const [data, total] = await this.reports.findAndCount({
      where,
      relations: { branch: true },
      order: { date: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** Upsert one branch's report for the day (the system recomputation path). */
  private async generateForBranch(
    tenantId: string,
    branchId: string,
    dateStr: string,
  ): Promise<DailyReport> {
    const metrics = await this.aggregation.computeDailyMetrics(
      tenantId,
      branchId,
      dateStr,
    );

    let report = await this.reports.findOne({
      where: {
        tenant: { id: tenantId },
        branch: { id: branchId },
        date: dateStr as unknown as Date,
      },
    });
    if (!report) {
      report = this.reports.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        date: dateStr as unknown as Date,
      });
    }

    report.total_appointments = metrics.total_appointments;
    report.completed_appointments = metrics.completed_appointments;
    report.cancelled_appointments = metrics.cancelled_appointments;
    report.total_revenue = metrics.total_revenue;
    report.new_customers = metrics.new_customers;
    report.ai_messages_count = metrics.ai_messages_count;

    return this.reports.save(report);
  }
}
