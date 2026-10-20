/**
 * MEASUREMENT — the trend endpoints' database cost on a cache hit.
 *
 * `/analytics/trends/appointments` and `/analytics/trends/revenue` are two of
 * the eleven requests `/app/dashboard` used to fire, and neither was cached:
 * every open, every reload, every tab, re-ran the aggregation (plus a
 * `tenant_settings` read for the currency). The module already owned a
 * per-tenant Redis read-through with version-counter invalidation —
 * `AnalyticsCacheService`, used by the KPI snapshot and target progress — it
 * simply was not wired to these two routes.
 *
 * Two properties are asserted, and the second is the one that matters for
 * safety:
 *
 *  1. A cache hit performs ZERO aggregation queries.
 *  2. Branch SCOPE is resolved BEFORE the cache is consulted, and is part of
 *     the key. Caching an authorization decision, or letting a
 *     branch-restricted caller read the tenant-wide entry, would turn a
 *     performance fix into a data leak.
 *
 * Pure unit test — no database. The aggregation SQL itself is asserted against
 * real Postgres by `advanced-analytics.service.spec.ts`.
 */
import { AdvancedAnalyticsService } from './advanced-analytics.service';
import { PERMISSION } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

const TENANT = 'tenant-1';
const RANGE = { from: '2026-08-18', to: '2026-08-31' };

const TENANT_WIDE: AuthenticatedUser = {
  id: 'owner',
  tenantId: TENANT,
  roles: [],
  permissions: [PERMISSION.ANALYTICS_DASHBOARD_READ],
} as AuthenticatedUser;

/** Holds only `analytics.reports.read`, so `resolveScope` pins them to their branch. */
const BRANCH_RESTRICTED: AuthenticatedUser = {
  id: 'manager',
  tenantId: TENANT,
  roles: [],
  permissions: [PERMISSION.ANALYTICS_REPORTS_READ],
} as AuthenticatedUser;

function build(options: { cached?: unknown } = {}) {
  const tenantSettings = {
    findOne: jest.fn().mockResolvedValue({ currency: 'SAR' }),
  };
  const aggregation = {
    // The currency read now lives on the aggregation engine
    // (`resolveReportingCurrency`); it still reads tenant settings, so the
    // "no currency read on a cache hit" assertions below keep their meaning.
    resolveReportingCurrency: jest.fn(async () => {
      const settings = (await tenantSettings.findOne()) as { currency: string };
      return {
        currency: settings.currency,
        configuredCurrency: settings.currency,
      };
    }),
    unattributedRevenue: jest.fn().mockResolvedValue(0),
    appointmentsTrend: jest.fn().mockResolvedValue([]),
    revenueTrend: jest.fn().mockResolvedValue([]),
    countOtherCurrencyRevenue: jest
      .fn()
      .mockResolvedValue({ count: 0, amount: 0 }),
    assertBranch: jest.fn().mockResolvedValue(undefined),
    computeRates: jest.fn().mockResolvedValue({
      total: 0,
      cancelled: 0,
      cancelledByPatient: 0,
      cancelledByClinic: 0,
      no_show: 0,
      completed: 0,
    }),
    computeRetention: jest.fn().mockResolvedValue({
      priorPeriodPatients: 0,
      retainedPatients: 0,
      repeatDistribution: {},
    }),
    servicePerformance: jest.fn().mockResolvedValue([]),
    branchPerformance: jest.fn().mockResolvedValue([]),
    channelPerformance: jest.fn().mockResolvedValue([]),
  };

  const cacheKeys: string[] = [];
  const cache = {
    wrap: <T>(
      _tenantId: string,
      _ns: string,
      suffix: string,
      producer: () => Promise<T>,
    ) => {
      cacheKeys.push(suffix);
      return 'cached' in options
        ? Promise.resolve(options.cached as T)
        : producer();
    },
  };

  /**
   * The shared `BranchScopeService` — which now owns the one `branch_users`
   * lookup in the codebase — rather than the repository this suite used to
   * hand in directly. The assertions below are unchanged in meaning: they
   * still prove that branch-scope RESOLUTION happens on every call, before
   * the cache is consulted, and is therefore never cached itself.
   */
  const branchScope = {
    getMembershipBranchIds: jest.fn().mockResolvedValue(['branch-b']),
  };
  const service = new AdvancedAnalyticsService(
    aggregation as never,
    branchScope as never,
    tenantSettings as never,
    cache as never,
  );

  return {
    service,
    aggregation,
    cache,
    cacheKeys,
    branchScope,
    tenantSettings,
  };
}

describe('AdvancedAnalyticsService — trend caching', () => {
  describe('a cache hit costs nothing', () => {
    it('runs no aggregation and no currency read when the payload is cached', async () => {
      const cached = {
        range: RANGE,
        scope: { branchId: 'ALL' },
        currency: 'SAR',
        generatedAt: '2026-08-31T00:00:00.000Z',
        empty: true,
        data: [],
      };
      const { service, aggregation, tenantSettings } = build({ cached });

      const result = await service.appointmentsTrend(
        TENANT,
        TENANT_WIDE,
        RANGE as never,
      );

      expect(result).toEqual(cached);
      expect(aggregation.appointmentsTrend).not.toHaveBeenCalled();
      // The currency read lives INSIDE the cached producer, so it is skipped
      // too. It was previously a `tenant_settings` query on every trend
      // request — two per dashboard open, for a value that changes annually.
      expect(tenantSettings.findOne).not.toHaveBeenCalled();
    });

    it('revenue: neither aggregation query runs on a hit', async () => {
      const { service, aggregation } = build({
        cached: { empty: true, data: [] },
      });

      await service.revenueTrend(TENANT, TENANT_WIDE, RANGE as never);

      expect(aggregation.revenueTrend).not.toHaveBeenCalled();
      expect(aggregation.countOtherCurrencyRevenue).not.toHaveBeenCalled();
    });

    it('a MISS still reaches the aggregation engine', async () => {
      const { service, aggregation } = build();

      await service.appointmentsTrend(TENANT, TENANT_WIDE, RANGE as never);

      expect(aggregation.appointmentsTrend).toHaveBeenCalledTimes(1);
    });
  });

  describe('authorization is never cached', () => {
    it('resolves branch scope BEFORE consulting the cache', async () => {
      const { service, branchScope } = build({
        cached: { empty: true, data: [] },
      });

      await service.appointmentsTrend(
        TENANT,
        BRANCH_RESTRICTED,
        RANGE as never,
      );

      // Even on a hit, the caller's own branch membership was read. Skipping
      // this to save a query would mean the cache decided who sees what.
      expect(branchScope.getMembershipBranchIds).toHaveBeenCalledTimes(1);
    });

    it('rejects a branch the caller is not assigned to, hit or miss', async () => {
      const { service } = build({ cached: { empty: true, data: [] } });

      await expect(
        service.appointmentsTrend(TENANT, BRANCH_RESTRICTED, {
          ...RANGE,
          branchId: 'branch-somebody-else',
        } as never),
      ).rejects.toThrow();
    });

    it('keys the cache on the RESOLVED branch, so scopes never share an entry', async () => {
      const wide = build();
      await wide.service.appointmentsTrend(TENANT, TENANT_WIDE, RANGE as never);

      const narrow = build();
      await narrow.service.appointmentsTrend(
        TENANT,
        BRANCH_RESTRICTED,
        RANGE as never,
      );

      expect(wide.cacheKeys[0]).toContain('ALL');
      expect(narrow.cacheKeys[0]).toContain('branch-b');
      expect(wide.cacheKeys[0]).not.toEqual(narrow.cacheKeys[0]);
    });

    it('keys the cache on the range, so yesterday’s window is not served for today’s', async () => {
      const a = build();
      await a.service.appointmentsTrend(TENANT, TENANT_WIDE, RANGE as never);

      const b = build();
      await b.service.appointmentsTrend(TENANT, TENANT_WIDE, {
        from: '2026-08-17',
        to: '2026-08-30',
      } as never);

      expect(a.cacheKeys[0]).not.toEqual(b.cacheKeys[0]);
    });

    it('gives the two trends different keys', async () => {
      const { service, cacheKeys } = build();

      await service.appointmentsTrend(TENANT, TENANT_WIDE, RANGE as never);
      await service.revenueTrend(TENANT, TENANT_WIDE, RANGE as never);

      expect(cacheKeys[0]).not.toEqual(cacheKeys[1]);
    });
  });
});

/**
 * T056 (P8, CACHE-002) — extends the pattern proven above to the five
 * non-trend aggregates wrapped in T055: `rates`, `retention`,
 * `performanceServices`, `performanceBranches`, `performanceChannels`.
 * (`performanceStaff` is deliberately NOT wrapped — no frontend consumer,
 * verified during P3 — so it is not covered here.)
 *
 * `rates`/`retention` cache the whole envelope+result, exactly like the
 * trend methods. The three paginated methods cache only the aggregation
 * (envelope + unpaginated rows) — `page`/`limit` are applied to whatever
 * `cache.wrap` returns, hit or miss — so the "cached" fixtures below use
 * that PRE-pagination shape, not the final HTTP response shape.
 */
const PAGE_DTO = { ...RANGE, page: 1, limit: 20 };
const ENVELOPE = {
  range: RANGE,
  scope: { branchId: 'ALL' },
  currency: 'SAR',
  generatedAt: '2026-08-31T00:00:00.000Z',
};

describe('AdvancedAnalyticsService — aggregate caching (T056, P8, CACHE-002)', () => {
  describe('rates', () => {
    it('a hit runs no aggregation and no currency read', async () => {
      const { service, aggregation, tenantSettings } = build({
        cached: { ...ENVELOPE, empty: true },
      });

      await service.rates(TENANT, TENANT_WIDE, RANGE as never);

      expect(aggregation.computeRates).not.toHaveBeenCalled();
      expect(tenantSettings.findOne).not.toHaveBeenCalled();
    });

    it('a miss still reaches the aggregation engine', async () => {
      const { service, aggregation } = build();

      await service.rates(TENANT, TENANT_WIDE, RANGE as never);

      expect(aggregation.computeRates).toHaveBeenCalledTimes(1);
    });

    it('resolves branch scope BEFORE consulting the cache, even on a hit', async () => {
      const { service, branchScope } = build({
        cached: { ...ENVELOPE, empty: true },
      });

      await service.rates(TENANT, BRANCH_RESTRICTED, RANGE as never);

      expect(branchScope.getMembershipBranchIds).toHaveBeenCalledTimes(1);
    });

    it('rejects a branch the caller is not assigned to, even on a hit', async () => {
      const { service } = build({ cached: { ...ENVELOPE, empty: true } });

      await expect(
        service.rates(TENANT, BRANCH_RESTRICTED, {
          ...RANGE,
          branchId: 'branch-somebody-else',
        } as never),
      ).rejects.toThrow();
    });

    it('keys the cache on the resolved branch and range', async () => {
      const wide = build();
      await wide.service.rates(TENANT, TENANT_WIDE, RANGE as never);
      const narrow = build();
      await narrow.service.rates(TENANT, BRANCH_RESTRICTED, RANGE as never);
      expect(wide.cacheKeys[0]).not.toEqual(narrow.cacheKeys[0]);
    });
  });

  describe('retention', () => {
    it('a hit runs no aggregation and no currency read', async () => {
      const { service, aggregation, tenantSettings } = build({
        cached: { ...ENVELOPE, empty: true },
      });

      await service.retention(TENANT, TENANT_WIDE, RANGE as never);

      expect(aggregation.computeRetention).not.toHaveBeenCalled();
      expect(tenantSettings.findOne).not.toHaveBeenCalled();
    });

    it('a miss still reaches the aggregation engine', async () => {
      const { service, aggregation } = build();

      await service.retention(TENANT, TENANT_WIDE, RANGE as never);

      expect(aggregation.computeRetention).toHaveBeenCalledTimes(1);
    });

    it('resolves branch scope BEFORE consulting the cache, even on a hit', async () => {
      const { service, branchScope } = build({
        cached: { ...ENVELOPE, empty: true },
      });

      await service.retention(TENANT, BRANCH_RESTRICTED, RANGE as never);

      expect(branchScope.getMembershipBranchIds).toHaveBeenCalledTimes(1);
    });

    it('rejects a branch the caller is not assigned to, even on a hit', async () => {
      const { service } = build({ cached: { ...ENVELOPE, empty: true } });

      await expect(
        service.retention(TENANT, BRANCH_RESTRICTED, {
          ...RANGE,
          branchId: 'branch-somebody-else',
        } as never),
      ).rejects.toThrow();
    });
  });

  describe('performanceServices', () => {
    it('a hit runs no aggregation and no currency read', async () => {
      const cached = { envelope: ENVELOPE, rows: [] };
      const { service, aggregation, tenantSettings } = build({ cached });

      await service.performanceServices(TENANT, TENANT_WIDE, PAGE_DTO as never);

      expect(aggregation.servicePerformance).not.toHaveBeenCalled();
      expect(tenantSettings.findOne).not.toHaveBeenCalled();
    });

    it('a miss still reaches the aggregation engine', async () => {
      const { service, aggregation } = build();

      await service.performanceServices(TENANT, TENANT_WIDE, PAGE_DTO as never);

      expect(aggregation.servicePerformance).toHaveBeenCalledTimes(1);
    });

    it('resolves branch scope BEFORE consulting the cache, even on a hit', async () => {
      const cached = { envelope: ENVELOPE, rows: [] };
      const { service, branchScope } = build({ cached });

      await service.performanceServices(
        TENANT,
        BRANCH_RESTRICTED,
        PAGE_DTO as never,
      );

      expect(branchScope.getMembershipBranchIds).toHaveBeenCalledTimes(1);
    });

    it('rejects a branch the caller is not assigned to, even on a hit', async () => {
      const cached = { envelope: ENVELOPE, rows: [] };
      const { service } = build({ cached });

      await expect(
        service.performanceServices(TENANT, BRANCH_RESTRICTED, {
          ...PAGE_DTO,
          branchId: 'branch-somebody-else',
        } as never),
      ).rejects.toThrow();
    });

    it('response body is unchanged in shape on a hit (envelope + paginated data)', async () => {
      const cached = {
        envelope: ENVELOPE,
        rows: [{ serviceId: 's1', appointments: 3, price: 100 }],
      };
      const { service } = build({ cached });

      const result = await service.performanceServices(
        TENANT,
        TENANT_WIDE,
        PAGE_DTO as never,
      );

      expect(result).toEqual({
        ...ENVELOPE,
        empty: false,
        data: cached.rows,
        total: 1,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('performanceBranches', () => {
    it('a hit runs no aggregation and no currency read', async () => {
      const cached = {
        envelope: ENVELOPE,
        excluded: {},
        rows: [],
        anyActivity: false,
      };
      const { service, aggregation, tenantSettings } = build({ cached });

      await service.performanceBranches(TENANT, TENANT_WIDE, PAGE_DTO as never);

      expect(aggregation.branchPerformance).not.toHaveBeenCalled();
      expect(aggregation.countOtherCurrencyRevenue).not.toHaveBeenCalled();
      expect(tenantSettings.findOne).not.toHaveBeenCalled();
    });

    it('a miss still reaches the aggregation engine', async () => {
      const { service, aggregation } = build();

      await service.performanceBranches(TENANT, TENANT_WIDE, PAGE_DTO as never);

      expect(aggregation.branchPerformance).toHaveBeenCalledTimes(1);
      expect(aggregation.countOtherCurrencyRevenue).toHaveBeenCalledTimes(1);
    });

    it('resolves branch scope BEFORE consulting the cache, even on a hit', async () => {
      const cached = {
        envelope: ENVELOPE,
        excluded: {},
        rows: [],
        anyActivity: false,
      };
      const { service, branchScope } = build({ cached });

      await service.performanceBranches(
        TENANT,
        BRANCH_RESTRICTED,
        PAGE_DTO as never,
      );

      expect(branchScope.getMembershipBranchIds).toHaveBeenCalledTimes(1);
    });

    it('rejects a branch the caller is not assigned to, even on a hit', async () => {
      const cached = {
        envelope: ENVELOPE,
        excluded: {},
        rows: [],
        anyActivity: false,
      };
      const { service } = build({ cached });

      await expect(
        service.performanceBranches(TENANT, BRANCH_RESTRICTED, {
          ...PAGE_DTO,
          branchId: 'branch-somebody-else',
        } as never),
      ).rejects.toThrow();
    });
  });

  describe('performanceChannels', () => {
    it('a hit runs no aggregation and no currency read', async () => {
      const cached = {
        envelope: ENVELOPE,
        excluded: {},
        data: [],
        totalAppointments: 0,
      };
      const { service, aggregation, tenantSettings } = build({ cached });

      await service.performanceChannels(TENANT, TENANT_WIDE, PAGE_DTO as never);

      expect(aggregation.channelPerformance).not.toHaveBeenCalled();
      expect(aggregation.countOtherCurrencyRevenue).not.toHaveBeenCalled();
      expect(tenantSettings.findOne).not.toHaveBeenCalled();
    });

    it('a miss still reaches the aggregation engine', async () => {
      const { service, aggregation } = build();

      await service.performanceChannels(TENANT, TENANT_WIDE, PAGE_DTO as never);

      expect(aggregation.channelPerformance).toHaveBeenCalledTimes(1);
      expect(aggregation.countOtherCurrencyRevenue).toHaveBeenCalledTimes(1);
    });

    it('resolves branch scope BEFORE consulting the cache, even on a hit', async () => {
      const cached = {
        envelope: ENVELOPE,
        excluded: {},
        data: [],
        totalAppointments: 0,
      };
      const { service, branchScope } = build({ cached });

      await service.performanceChannels(
        TENANT,
        BRANCH_RESTRICTED,
        PAGE_DTO as never,
      );

      expect(branchScope.getMembershipBranchIds).toHaveBeenCalledTimes(1);
    });

    it('rejects a branch the caller is not assigned to, even on a hit', async () => {
      const cached = {
        envelope: ENVELOPE,
        excluded: {},
        data: [],
        totalAppointments: 0,
      };
      const { service } = build({ cached });

      await expect(
        service.performanceChannels(TENANT, BRANCH_RESTRICTED, {
          ...PAGE_DTO,
          branchId: 'branch-somebody-else',
        } as never),
      ).rejects.toThrow();
    });
  });

  it('every one of the five aggregates gets its own cache key', async () => {
    const { service, cacheKeys } = build();

    await service.rates(TENANT, TENANT_WIDE, RANGE as never);
    await service.retention(TENANT, TENANT_WIDE, RANGE as never);
    await service.performanceServices(TENANT, TENANT_WIDE, PAGE_DTO as never);
    await service.performanceBranches(TENANT, TENANT_WIDE, PAGE_DTO as never);
    await service.performanceChannels(TENANT, TENANT_WIDE, PAGE_DTO as never);

    expect(new Set(cacheKeys).size).toBe(cacheKeys.length);
  });

  it('a Redis outage (cache.wrap failing open to producer()) still returns correct data', async () => {
    // The `build()` fixture's `cache.wrap` mimics the REAL
    // `AnalyticsCacheService`'s fail-open behavior when no `cached` option is
    // given: it always calls `producer()` directly, exactly what happens when
    // Redis is unreachable.
    const { service, aggregation } = build();
    aggregation.computeRates.mockResolvedValueOnce({
      total: 10,
      cancelled: 2,
      cancelledByPatient: 2,
      cancelledByClinic: 0,
      no_show: 1,
      completed: 7,
    });

    const result = await service.rates(TENANT, TENANT_WIDE, RANGE as never);

    expect(result).toMatchObject({ empty: false, cancellationRate: 0.2 });
  });
});
