import { Injectable } from '@nestjs/common';

import {
  AnalyticsAggregationService,
  StaffPerformanceRow,
} from './analytics-aggregation.service';
import { AnalyticsCacheService, CACHE_NS } from './analytics-cache.service';
import { QueryStaffPerformanceDto } from './dto/query-staff-performance.dto';

/**
 * Fleet-wide staff performance — a live, cached read (nothing persisted, no
 * `generate` step). Unlike daily/monthly reports, this data is cheap to
 * recompute on demand (bounded by a tenant's staff count) and nothing writes
 * to it through this module, so it only needs a TTL-bound cache, never an
 * invalidation hook — same reasoning as `DailyReportService.list`'s cache use.
 */
@Injectable()
export class StaffPerformanceService {
  constructor(
    private readonly aggregation: AnalyticsAggregationService,
    private readonly cache: AnalyticsCacheService,
  ) {}

  list(
    tenantId: string,
    query: QueryStaffPerformanceDto,
  ): Promise<StaffPerformanceRow[]> {
    const suffix = `list:${query.branchId ?? '*'}:${query.from ?? '*'}:${query.to ?? '*'}`;
    return this.cache.wrap(tenantId, CACHE_NS.STAFF, suffix, () =>
      this.aggregation.computeStaffPerformance(tenantId, {
        branchId: query.branchId,
        from: query.from,
        to: query.to,
      }),
    );
  }
}
