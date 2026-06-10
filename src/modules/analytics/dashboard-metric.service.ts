import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';

import { DashboardMetric } from '../../entities/Analytics/DashboardMetric';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { QueryDashboardDto } from './dto/query-dashboard.dto';
import { DASHBOARD_PERIOD } from './analytics.constants';

/**
 * Dashboard fast-read layer (`dashboard_metrics`).
 *
 * Reads are pure key/value lookups — NO computation on the request path (that is
 * what makes the dashboard fast). Metrics are (re)computed only by `refresh`,
 * which delegates the heavy aggregation to AnalyticsAggregationService and
 * upserts the snapshot rows. Tenant-scoped via the `tenant` relation.
 */
@Injectable()
export class DashboardMetricService {
  constructor(
    @InjectRepository(DashboardMetric)
    private readonly metrics: Repository<DashboardMetric>,
    private readonly aggregation: AnalyticsAggregationService,
  ) {}

  /** Fast read: returns the precomputed metric snapshot for the tenant. */
  getMetrics(tenantId: string, query: QueryDashboardDto): Promise<DashboardMetric[]> {
    const where: FindOptionsWhere<DashboardMetric> = { tenant: { id: tenantId } };
    if (query.metricKey) where.metric_key = query.metricKey;
    return this.metrics.find({ where, order: { metric_key: 'ASC' } });
  }

  /** Recompute the KPI snapshot and upsert the metric rows. */
  async refresh(tenantId: string): Promise<DashboardMetric[]> {
    const kpis = await this.aggregation.computeDashboardKpis(tenantId);
    const saved: DashboardMetric[] = [];

    for (const kpi of kpis) {
      let row = await this.metrics.findOne({
        where: {
          tenant: { id: tenantId },
          metric_key: kpi.metric_key,
          period: kpi.period,
        },
      });
      if (!row) {
        row = this.metrics.create({
          tenant: { id: tenantId } as Tenant,
          metric_key: kpi.metric_key,
          period: kpi.period ?? DASHBOARD_PERIOD,
        });
      }
      row.metric_value = kpi.metric_value;
      row.updated_at = new Date();
      saved.push(await this.metrics.save(row));
    }
    return saved;
  }
}
