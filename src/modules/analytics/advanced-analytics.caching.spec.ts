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
  const aggregation = {
    appointmentsTrend: jest.fn().mockResolvedValue([]),
    revenueTrend: jest.fn().mockResolvedValue([]),
    countOtherCurrencyRevenue: jest
      .fn()
      .mockResolvedValue({ count: 0, amount: 0 }),
    assertBranch: jest.fn().mockResolvedValue(undefined),
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

  const branchUsers = {
    find: jest.fn().mockResolvedValue([{ branch: { id: 'branch-b' } }]),
  };
  const tenantSettings = {
    findOne: jest.fn().mockResolvedValue({ currency: 'SAR' }),
  };

  const service = new AdvancedAnalyticsService(
    aggregation as never,
    branchUsers as never,
    tenantSettings as never,
    cache as never,
  );

  return {
    service,
    aggregation,
    cache,
    cacheKeys,
    branchUsers,
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
      const { service, branchUsers } = build({
        cached: { empty: true, data: [] },
      });

      await service.appointmentsTrend(
        TENANT,
        BRANCH_RESTRICTED,
        RANGE as never,
      );

      // Even on a hit, the caller's own branch membership was read. Skipping
      // this to save a query would mean the cache decided who sees what.
      expect(branchUsers.find).toHaveBeenCalledTimes(1);
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
