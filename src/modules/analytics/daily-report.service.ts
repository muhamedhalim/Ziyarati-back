import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DailyReport } from '../../entities/Analytics/DailyReport';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsCacheService, CACHE_NS } from './analytics-cache.service';
import { GenerateDailyReportDto } from './dto/generate-daily-report.dto';
import { QueryDailyReportsDto } from './dto/query-daily-reports.dto';
import { reportDateColumn } from './analytics.constants';
import { BatchResult, mapBranchesSettled } from './batch.util';
import { Page, ReportQueryBuilder } from './query/report-query.builder';

/**
 * Daily reports (`daily_reports`) — pre-aggregated, per tenant + branch + day.
 *
 * Tenant-scoped via the `tenant` relation. Reports are immutable to clients (no
 * update endpoint); `generate` performs the only allowed write — a system
 * (re)computation that upserts on the (tenant, branch, date) unique key. With no
 * `branchId`, all active branches are generated as a bounded-concurrency batch
 * with partial-failure isolation (one bad branch never aborts the rest).
 *
 * Reads (`get` / `list`) are Redis read-through cached per tenant; any
 * generation invalidates the tenant's `daily` cache namespace so reads are never
 * stale.
 */
@Injectable()
export class DailyReportService {
  private readonly logger = new Logger('DailyReportService');

  constructor(
    @InjectRepository(DailyReport)
    private readonly reports: Repository<DailyReport>,
    private readonly aggregation: AnalyticsAggregationService,
    private readonly cache: AnalyticsCacheService,
  ) {}

  async generate(
    tenantId: string,
    dto: GenerateDailyReportDto,
  ): Promise<DailyReport | BatchResult<DailyReport>> {
    // Single-branch path: validate ownership, generate, surface errors directly.
    if (dto.branchId) {
      const branch = await this.aggregation.assertBranch(tenantId, dto.branchId);
      const report = await this.generateForBranch(tenantId, branch.id, dto.date);
      await this.cache.invalidate(tenantId, CACHE_NS.DAILY);
      return report;
    }

    // Batch path: all active branches, bounded concurrency, isolate failures.
    const branchIds = await this.aggregation.listActiveBranchIds(tenantId);
    if (branchIds.length === 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'No active branches to generate a report for',
      });
    }

    const result = await mapBranchesSettled(branchIds, (branchId) =>
      this.generateForBranch(tenantId, branchId, dto.date),
    );

    for (const f of result.failed) {
      this.logger.error(
        `daily report failed tenant=${tenantId} branch=${f.branchId} date=${dto.date}: ${f.error}`,
      );
    }

    // Invalidate once after the batch (any successful write changes read results).
    if (result.generated.length > 0) {
      await this.cache.invalidate(tenantId, CACHE_NS.DAILY);
    }
    return result;
  }

  get(tenantId: string, id: string): Promise<DailyReport> {
    return this.cache.wrap(tenantId, CACHE_NS.DAILY, `id:${id}`, async () => {
      const report = await ReportQueryBuilder.scoped(
        this.reports.createQueryBuilder('report'),
        'report',
        tenantId,
      )
        .andWhere('report.id = :id', { id })
        .getOne();
      if (!report) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Daily report not found' });
      }
      return report;
    });
  }

  list(tenantId: string, query: QueryDailyReportsDto): Promise<Page<DailyReport>> {
    const suffix = `list:${query.branchId ?? '*'}:${query.from ?? '*'}:${query.to ?? '*'}:${query.page}:${query.limit}`;
    return this.cache.wrap(tenantId, CACHE_NS.DAILY, suffix, () => {
      let qb = ReportQueryBuilder.scoped(
        this.reports.createQueryBuilder('report'),
        'report',
        tenantId,
      );
      qb = ReportQueryBuilder.branch(qb, query.branchId);
      qb = ReportQueryBuilder.dateRange(qb, 'report', query.from, query.to);
      return ReportQueryBuilder.page(qb, 'report', 'date', query);
    });
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
        date: reportDateColumn(dateStr),
      },
    });
    if (!report) {
      report = this.reports.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        date: reportDateColumn(dateStr),
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
