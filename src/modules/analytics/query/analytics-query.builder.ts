import { SelectQueryBuilder } from 'typeorm';

import { Page, PageRequest } from './report-query.builder';

export interface EventFilters {
  eventType?: string;
  entityType?: string;
  branchId?: string;
  /** ISO-8601 timestamps; converted to Date bounds for the timestamptz column. */
  from?: string;
  to?: string;
}

/**
 * Centralized, tenant-safe filter helpers for the raw event log
 * (`analytics_events`).
 *
 * Unlike report dates, event `created_at` is a `timestamptz`, so range bounds
 * are real `Date` objects (per the date strategy). Tenant scoping is the single
 * enforced entry point via `scoped()`; the tenant id always comes from
 * TenantContext, never request input.
 */
export class AnalyticsQueryBuilder {
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

  static filters<T extends object>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    f: EventFilters,
  ): SelectQueryBuilder<T> {
    if (f.eventType) qb.andWhere(`${alias}.event_type = :eventType`, { eventType: f.eventType });
    if (f.entityType) qb.andWhere(`${alias}.entity_type = :entityType`, { entityType: f.entityType });
    if (f.branchId) qb.andWhere('branch.id = :branchId', { branchId: f.branchId });

    // Inclusive [from, to] window on the created_at timestamp.
    if (f.from && f.to) {
      qb.andWhere(`${alias}.created_at BETWEEN :from AND :to`, {
        from: new Date(f.from),
        to: new Date(f.to),
      });
    } else if (f.from) {
      qb.andWhere(`${alias}.created_at >= :from`, { from: new Date(f.from) });
    } else if (f.to) {
      qb.andWhere(`${alias}.created_at <= :to`, { to: new Date(f.to) });
    }
    return qb;
  }

  static async page<T extends object>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    { page, limit }: PageRequest,
  ): Promise<Page<T>> {
    const [data, total] = await qb
      .orderBy(`${alias}.created_at`, 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, limit };
  }
}
