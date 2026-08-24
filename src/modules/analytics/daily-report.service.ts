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
import {
  BatchResult,
  logBatchFailures,
  mapBranchesSettled,
} from './batch.util';
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
/**
 * Cache eligibility bounds for `list()` (gap-closure — see
 * docs/CACHING_QUEUES_AUDIT.md M13): `query.page`/`query.from`/`query.to` are
 * fully user-controlled, so caching every combination mints an unbounded
 * number of distinct 60s keys (a memory-growth vector, not a leak — every
 * key is still tenant-scoped, version-scoped and TTL'd). Cache only the
 * shape a real UI overwhelmingly requests — the first few pages of a
 * bounded-width date range — and read straight from Postgres for anything
 * wider (deep pagination, multi-year ranges): those are rare enough that
 * skipping the cache costs nothing, and NOT caching them is what actually
 * bounds the key count.
 */
const CACHEABLE_MAX_PAGE = 5;
const CACHEABLE_MAX_RANGE_DAYS = 31;

/** True when this query's cache key is worth minting — see the constants above. */
function isCacheableListQuery(query: QueryDailyReportsDto): boolean {
  if (query.page > CACHEABLE_MAX_PAGE) return false;
  if (query.from && query.to) {
    const spanMs =
      new Date(`${query.to}T00:00:00Z`).getTime() -
      new Date(`${query.from}T00:00:00Z`).getTime();
    const spanDays = spanMs / 86_400_000;
    if (
      !Number.isFinite(spanDays) ||
      spanDays < 0 ||
      spanDays > CACHEABLE_MAX_RANGE_DAYS
    )
      return false;
  }
  return true;
}

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
      const branch = await this.aggregation.assertBranch(
        tenantId,
        dto.branchId,
      );
      const report = await this.generateForBranch(
        tenantId,
        branch.id,
        dto.date,
      );
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

    logBatchFailures(
      this.logger,
      result.failed,
      `daily report tenant=${tenantId} date=${dto.date}`,
    );

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
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'Daily report not found',
        });
      }
      return report;
    });
  }

  list(
    tenantId: string,
    query: QueryDailyReportsDto,
  ): Promise<Page<DailyReport>> {
    const runQuery = () => {
      let qb = ReportQueryBuilder.scoped(
        this.reports.createQueryBuilder('report'),
        'report',
        tenantId,
      );
      qb = ReportQueryBuilder.branch(qb, query.branchId);
      qb = ReportQueryBuilder.dateRange(qb, 'report', query.from, query.to);
      return ReportQueryBuilder.page(qb, 'report', 'date', query);
    };

    // Deep pagination / wide-open date ranges bypass the cache entirely
    // (M13) — reading Postgres directly instead of minting a cache key that
    // will likely never be read again.
    if (!isCacheableListQuery(query)) return runQuery();

    const suffix = `list:${query.branchId ?? '*'}:${query.from ?? '*'}:${query.to ?? '*'}:${query.page}:${query.limit}`;
    return this.cache.wrap(tenantId, CACHE_NS.DAILY, suffix, runQuery);
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /**
   * Idempotent, concurrency-safe upsert of one branch's report for the day.
   *
   * `INSERT … ON CONFLICT (tenantId, branchId, date) DO UPDATE` is atomic against
   * the entity's unique constraint, so two concurrent generations of the same
   * (tenant, branch, date) can no longer both insert (the old find-then-save
   * raced into a 23505) — they collapse into one row, last write wins.
   */
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

    await this.reports
      .createQueryBuilder()
      .insert()
      .values({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        date: reportDateColumn(dateStr),
        total_appointments: metrics.total_appointments,
        completed_appointments: metrics.completed_appointments,
        cancelled_appointments: metrics.cancelled_appointments,
        no_show_appointments: metrics.no_show_appointments,
        total_revenue: metrics.total_revenue,
        new_customers: metrics.new_customers,
        ai_messages_count: metrics.ai_messages_count,
      })
      .orUpdate(
        [
          'total_appointments',
          'completed_appointments',
          'cancelled_appointments',
          'no_show_appointments',
          'total_revenue',
          'new_customers',
          'ai_messages_count',
        ],
        ['tenantId', 'branchId', 'date'],
      )
      .execute();

    const saved = await this.reports.findOne({
      where: {
        tenant: { id: tenantId },
        branch: { id: branchId },
        date: reportDateColumn(dateStr),
      },
      relations: { branch: true },
    });
    // The row was just upserted, so it must exist.
    return saved as DailyReport;
  }
}
