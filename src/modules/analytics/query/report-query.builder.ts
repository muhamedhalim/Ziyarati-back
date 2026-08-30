import { SelectQueryBuilder } from 'typeorm';

import { ReportDate, ReportMonth } from '../analytics.constants';

export interface PageRequest {
  page: number;
  limit: number;
}

export interface Page<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Centralized, tenant-safe filter helpers for the report read models
 * (`daily_reports`, `monthly_reports`).
 *
 * The previous code duplicated the same tenant/branch/date `FindOptionsWhere`
 * assembly across DailyReportService and MonthlyReportService, including the
 * unsafe `as any` date casts and an inconsistent to-bound (exclusive in one
 * path, inclusive in another). These helpers make tenant scoping a single
 * enforced entry point and standardize date bounds as INCLUSIVE on both ends
 * (matching the DTO docs), using string params against the `date` column per the
 * date strategy in analytics.constants.ts.
 *
 * The tenant id always originates from TenantContext upstream — never request
 * input — so callers pass it explicitly and `scoped()` is the only place tenant
 * isolation is applied.
 */
export class ReportQueryBuilder {
  /**
   * MANDATORY entry point: applies tenant isolation (inner join on the tenant
   * relation) and eager-loads the branch for output. Every report list/get
   * query must start here.
   */
  static scoped<T extends object>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    tenantId: string,
  ): SelectQueryBuilder<T> {
    return qb
      .innerJoin(`${alias}.tenant`, 'tenant')
      .leftJoinAndSelect(`${alias}.branch`, 'branch')
      .where('tenant.id = :tenantId', { tenantId });
  }

  /** Optional branch filter (branch is already joined by `scoped`). */
  static branch<T extends object>(
    qb: SelectQueryBuilder<T>,
    branchId?: string,
  ): SelectQueryBuilder<T> {
    if (branchId) qb.andWhere('branch.id = :branchId', { branchId });
    return qb;
  }

  /** Inclusive [from, to] range on a 'YYYY-MM-DD' date column. */
  static dateRange<T extends object>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    from?: ReportDate,
    to?: ReportDate,
  ): SelectQueryBuilder<T> {
    if (from && to) {
      qb.andWhere(`${alias}.date BETWEEN :from AND :to`, { from, to });
    } else if (from) {
      qb.andWhere(`${alias}.date >= :from`, { from });
    } else if (to) {
      qb.andWhere(`${alias}.date <= :to`, { to });
    }
    return qb;
  }

  /** Exact 'YYYY-MM' month filter on `period_month`. */
  static month<T extends object>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    month?: ReportMonth,
  ): SelectQueryBuilder<T> {
    if (month) qb.andWhere(`${alias}.period_month = :month`, { month });
    return qb;
  }

  /**
   * Spec 014 (Clinic Platform Completion) — T022 (S6, FR-A002). The reusable
   * `(from, to, branchId?)` scope for RAW source-table queries (an
   * appointment/payment timeline, not the pre-aggregated `daily_reports` /
   * `monthly_reports` tables `dateRange`/`month` above already cover).
   * Branch scope is derived from the caller's own already-resolved value —
   * NEVER from a raw request parameter passed straight through — so callers
   * must resolve/authorize `branchId` themselves before reaching here, the
   * same discipline `scoped()` already enforces for `tenantId`.
   *
   * `column` is the entity's own timestamptz column name (e.g. `paid_at`,
   * `created_at`) — always a fixed identifier the calling code selects, so
   * this never interpolates caller-supplied SQL.
   */
  static instantRange<T extends object>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    column: string,
    from: Date,
    to: Date,
    branchId?: string,
  ): SelectQueryBuilder<T> {
    qb.andWhere(`${alias}.${column} BETWEEN :instantFrom AND :instantTo`, {
      instantFrom: from,
      instantTo: to,
    });
    if (branchId) qb.andWhere(`${alias}.branch = :instantBranchId`, { instantBranchId: branchId });
    return qb;
  }

  /** Order + page, then execute, returning a standardized page envelope. */
  static async page<T extends object>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    orderColumn: string,
    { page, limit }: PageRequest,
  ): Promise<Page<T>> {
    const [data, total] = await qb
      .orderBy(`${alias}.${orderColumn}`, 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, limit };
  }
}
