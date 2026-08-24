import { StaffPerformanceService } from './staff-performance.service';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsCacheService } from './analytics-cache.service';

describe('StaffPerformanceService', () => {
  let service: StaffPerformanceService;
  let aggregation: { computeStaffPerformance: jest.Mock };
  let cache: { wrap: jest.Mock };

  beforeEach(() => {
    aggregation = { computeStaffPerformance: jest.fn().mockResolvedValue([]) };
    cache = {
      wrap: jest.fn((_tenantId, _ns, _suffix, producer) => producer()),
    };
    service = new StaffPerformanceService(
      aggregation as unknown as AnalyticsAggregationService,
      cache as unknown as AnalyticsCacheService,
    );
  });

  it('delegates to the aggregation engine with the tenant + filters', async () => {
    await service.list('t1', {
      branchId: 'b1',
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(aggregation.computeStaffPerformance).toHaveBeenCalledWith('t1', {
      branchId: 'b1',
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it('caches under the STAFF namespace, keyed by branch + date window', async () => {
    await service.list('t1', {});
    expect(cache.wrap).toHaveBeenCalledWith(
      't1',
      'staff',
      'list:*:*:*',
      expect.any(Function),
    );
  });

  it('mints a distinct cache key per filter combination', async () => {
    await service.list('t1', { branchId: 'b1' });
    expect(cache.wrap).toHaveBeenCalledWith(
      't1',
      'staff',
      'list:b1:*:*',
      expect.any(Function),
    );
  });
});
