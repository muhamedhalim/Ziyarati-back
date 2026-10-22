import { DailyReportService } from './daily-report.service';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsCacheService } from './analytics-cache.service';
import { ErrorCode } from '../../common/errors';

function buildChainableQb(result: [unknown[], number] = [[], 0]) {
  const qb: Record<string, jest.Mock> = {};
  const chain = [
    'innerJoin',
    'leftJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'skip',
    'take',
  ];
  for (const method of chain) qb[method] = jest.fn(() => qb);
  qb.getManyAndCount = jest.fn().mockResolvedValue(result);
  return qb;
}

describe('DailyReportService.list — cache eligibility gating (M13)', () => {
  let service: DailyReportService;
  let reports: { createQueryBuilder: jest.Mock };
  let cache: { wrap: jest.Mock; invalidate: jest.Mock };

  beforeEach(() => {
    reports = { createQueryBuilder: jest.fn(() => buildChainableQb()) };
    cache = {
      wrap: jest.fn((_tenantId, _ns, _suffix, producer) => producer()),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    service = new DailyReportService(
      reports as any,
      {} as unknown as AnalyticsAggregationService,
      cache as unknown as AnalyticsCacheService,
    );
  });

  it('caches page 1 with no date range (the common, high-traffic case)', async () => {
    await service.list('t1', { page: 1, limit: 31 } as any);
    expect(cache.wrap).toHaveBeenCalledTimes(1);
  });

  it('caches a bounded-width date range within the first few pages', async () => {
    await service.list('t1', {
      page: 2,
      limit: 31,
      from: '2026-06-01',
      to: '2026-06-30',
    } as any);
    expect(cache.wrap).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache for deep pagination (page beyond the cacheable bound)', async () => {
    await service.list('t1', { page: 50, limit: 31 } as any);
    expect(cache.wrap).not.toHaveBeenCalled();
    expect(reports.createQueryBuilder).toHaveBeenCalled(); // still serves the request, just uncached
  });

  it('bypasses the cache for a wide-open date range (> the cacheable span)', async () => {
    await service.list('t1', {
      page: 1,
      limit: 31,
      from: '2020-01-01',
      to: '2026-01-01',
    } as any);
    expect(cache.wrap).not.toHaveBeenCalled();
  });

  it('bypasses the cache for an inverted date range rather than caching garbage', async () => {
    await service.list('t1', {
      page: 1,
      limit: 31,
      from: '2026-06-30',
      to: '2026-06-01',
    } as any);
    expect(cache.wrap).not.toHaveBeenCalled();
  });

  it('still returns the correct page envelope when bypassing the cache', async () => {
    reports.createQueryBuilder.mockReturnValueOnce(
      buildChainableQb([[{ id: 'r1' }], 1]),
    );
    const result = await service.list('t1', { page: 999, limit: 31 } as any);
    expect(result).toEqual({
      data: [{ id: 'r1' }],
      total: 1,
      page: 999,
      limit: 31,
    });
  });
});

describe('DailyReportService.generate — tenant with no active branches', () => {
  let service: DailyReportService;
  let aggregation: { listActiveBranchIds: jest.Mock; assertBranch: jest.Mock };
  let cache: { wrap: jest.Mock; invalidate: jest.Mock };

  beforeEach(() => {
    aggregation = {
      listActiveBranchIds: jest.fn().mockResolvedValue([]),
      assertBranch: jest.fn(),
    };
    cache = { wrap: jest.fn(), invalidate: jest.fn().mockResolvedValue(undefined) };
    service = new DailyReportService(
      { createQueryBuilder: jest.fn() } as any,
      aggregation as unknown as AnalyticsAggregationService,
      cache as unknown as AnalyticsCacheService,
    );
  });

  it('an interactive call still refuses with 422', async () => {
    await expect(service.generate('t1', { date: '2026-10-21' })).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('a scheduled call (skipWhenNoActiveBranches) records a skip, writes nothing, invalidates nothing', async () => {
    const result = await service.generate(
      't1',
      { date: '2026-10-21' },
      { skipWhenNoActiveBranches: true },
    );
    expect(result).toEqual({ generated: [], failed: [], skipped: 'no_active_branches' });
    expect(cache.invalidate).not.toHaveBeenCalled();
  });
});
