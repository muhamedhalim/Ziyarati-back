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
