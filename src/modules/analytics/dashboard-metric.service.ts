import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { DashboardMetric } from '../../entities/Analytics/DashboardMetric';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsCacheService, CACHE_NS } from './analytics-cache.service';
import { QueryDashboardDto } from './dto/query-dashboard.dto';
import { DASHBOARD_PERIOD } from './analytics.constants';

/**
 * Dashboard fast-read layer (`dashboard_metrics`).
 *
 * Reads are pure key/value lookups served through a Redis read-through cache
 * (NO computation on the request path — that is what makes the dashboard fast).
 * Metrics are (re)computed only by `refresh`, which delegates the heavy
 * aggregation to AnalyticsAggregationService, upserts the snapshot rows, and
 * invalidates the tenant's `dashboard` cache namespace so reads are never stale.
 * Tenant-scoped via the `tenant` relation.
 */
@Injectable()
export class DashboardMetricService {
  constructor(
    @InjectRepository(DashboardMetric)
    private readonly metrics: Repository<DashboardMetric>,
    private readonly aggregation: AnalyticsAggregationService,
    private readonly cache: AnalyticsCacheService,
  ) {}

  /** Fast read: returns the precomputed metric snapshot for the tenant (cached). */
  getMetrics(tenantId: string, query: QueryDashboardDto): Promise<DashboardMetric[]> {
    return this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      `metrics:${query.metricKey ?? '*'}`,
      () => {
        const where: FindOptionsWhere<DashboardMetric> = { tenant: { id: tenantId } };
        if (query.metricKey) where.metric_key = query.metricKey;
        return this.metrics.find({ where, order: { metric_key: 'ASC' } });
      },
    );
  }

  /**
   * Recompute the KPI snapshot and persist it ATOMICALLY.
   *
   * All rows are upserted inside a single transaction (`INSERT … ON CONFLICT
   * (tenantId, metric_key, period) DO UPDATE`), so:
   *  - the snapshot is all-or-nothing — a mid-loop failure no longer leaves a
   *    half-updated dashboard;
   *  - concurrent refreshes (API + the hourly worker sweep) can no longer create
   *    duplicate rows for the same metric (the old find-then-save raced).
   * Cache is invalidated AFTER commit so a concurrent read cannot repopulate the
   * cache with pre-commit data.
   */
  async refresh(tenantId: string): Promise<DashboardMetric[]> {
    const kpis = await this.aggregation.computeDashboardKpis(tenantId);

    await this.metrics.manager.transaction(async (manager) => {
      for (const kpi of kpis) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(DashboardMetric)
          .values({
            tenant: { id: tenantId } as Tenant,
            metric_key: kpi.metric_key,
            metric_value: kpi.metric_value,
            period: kpi.period ?? DASHBOARD_PERIOD,
            updated_at: new Date(),
          })
          .orUpdate(['metric_value', 'updated_at'], ['tenantId', 'metric_key', 'period'])
          .execute();
      }
    });

    await this.cache.invalidate(tenantId, CACHE_NS.DASHBOARD);

    return this.metrics.find({
      where: { tenant: { id: tenantId } },
      order: { metric_key: 'ASC' },
    });
  }
}
