/**
 * Pure unit test — no database (mirrors `advanced-analytics.caching.spec.ts`).
 * Uses a REAL `AdvancedAnalyticsService` instance (its own dependencies
 * mocked) so `validateRange`/`resolveScope`/`envelope` run their actual
 * logic — `PatientJourneyService` must reuse them, never reimplement them.
 */
import { AdvancedAnalyticsService } from '../advanced-analytics.service';
import { PatientJourneyService } from './patient-journey.service';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { AppError, ErrorCode } from '../../../common/errors';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import type { JourneyAggregate, JourneyOverallRow } from './journey.types';

const TENANT = 'tenant-1';
const RANGE = { from: '2026-08-01', to: '2026-08-31' };

const TENANT_WIDE: AuthenticatedUser = {
  id: 'owner',
  tenantId: TENANT,
  roles: [],
  permissions: [PERMISSION.ANALYTICS_DASHBOARD_READ],
} as AuthenticatedUser;

const BRANCH_RESTRICTED: AuthenticatedUser = {
  id: 'manager',
  tenantId: TENANT,
  roles: [],
  permissions: [PERMISSION.ANALYTICS_REPORTS_READ],
} as AuthenticatedUser;

function zeroRow(
  overrides: Partial<JourneyOverallRow> = {},
): JourneyOverallRow {
  return {
    booked: 0,
    cancelled: 0,
    no_show: 0,
    completed: 0,
    in_progress: 0,
    upcoming: 0,
    past: 0,
    unresolved_past: 0,
    arrived: 0,
    called: 0,
    started: 0,
    completed_with_queue: 0,
    completed_without_start: 0,
    completed_with_timing: 0,
    consult_too_short: 0,
    consult_invalid: 0,
    swept: 0,
    multi_service: 0,
    no_service: 0,
    tz_fallback: 0,
    start_from_queue: 0,
    start_from_log: 0,
    rem_eligible: 0,
    rem_with_row: 0,
    rem_reminded: 0,
    rem_failed_only: 0,
    resolved_reminded: 0,
    resolved_not_reminded: 0,
    no_show_reminded: 0,
    no_show_not_reminded: 0,
    lead_n: 0,
    lead_invalid: 0,
    lead_p50: null,
    lead_p90: null,
    arrival_n: 0,
    arrival_invalid: 0,
    arrival_late_n: 0,
    arrival_p50: null,
    arrival_p90: null,
    wait_call_n: 0,
    wait_call_invalid: 0,
    wait_call_p50: null,
    wait_call_p90: null,
    call_start_n: 0,
    call_start_invalid: 0,
    call_start_p50: null,
    call_start_p90: null,
    wait_start_n: 0,
    wait_start_invalid: 0,
    wait_start_p50: null,
    wait_start_p90: null,
    ready_delay_n: 0,
    ready_delay_invalid: 0,
    ready_delay_p50: null,
    ready_delay_p90: null,
    start_delay_n: 0,
    start_delay_invalid: 0,
    start_delay_p50: null,
    start_delay_p90: null,
    consult_n: 0,
    consult_p50: null,
    consult_p75: null,
    consult_p90: null,
    overrun_p50: null,
    overrun_p90: null,
    visit_n: 0,
    visit_invalid: 0,
    visit_p50: null,
    visit_p90: null,
    scheduled_p50: null,
    ...overrides,
  };
}

function emptyAggregate(
  overrides: Partial<JourneyAggregate> = {},
): JourneyAggregate {
  return {
    overall: zeroRow(),
    priorOverall: null,
    priorRange: null,
    byDimension: { branch: [], staff: [], service: [], weekday: [], hour: [] },
    reminderRows: [],
    labels: { branch: {}, staff: {}, service: {} },
    settings: {
      currency: 'SAR',
      remindersEnabled: false,
      reminderLeadMinutes: [],
    },
    now: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function build(options: { cached?: JourneyAggregate } = {}) {
  const journeyAgg = {
    fetchOverall: jest.fn().mockResolvedValue(zeroRow()),
    fetchDimension: jest.fn().mockResolvedValue([]),
    fetchReminderRows: jest.fn().mockResolvedValue([]),
    fetchBranchLabels: jest.fn().mockResolvedValue({}),
    fetchStaffLabels: jest.fn().mockResolvedValue({}),
    fetchServiceLabels: jest.fn().mockResolvedValue({}),
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

  const branchScope = {
    getMembershipBranchIds: jest.fn().mockResolvedValue(['branch-b']),
  };
  const tenantSettings = {
    findOne: jest.fn().mockResolvedValue({ currency: 'SAR' }),
  };
  const advancedAggregation = {
    assertBranch: jest.fn().mockResolvedValue(undefined),
  };

  const advanced = new AdvancedAnalyticsService(
    advancedAggregation as never,
    branchScope as never,
    tenantSettings as never,
    {
      wrap: () =>
        Promise.reject(
          new Error('advanced cache must not be used by journey tests'),
        ),
    } as never,
  );

  const service = new PatientJourneyService(
    journeyAgg as never,
    advanced,
    cache as never,
    tenantSettings as never,
  );

  return {
    service,
    journeyAgg,
    cache,
    cacheKeys,
    branchScope,
    tenantSettings,
    advancedAggregation,
  };
}

describe('PatientJourneyService — a cache hit costs nothing', () => {
  it('runs no aggregation queries and no label lookups when the aggregate is cached', async () => {
    const { service, journeyAgg } = build({ cached: emptyAggregate() });

    await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    expect(journeyAgg.fetchOverall).not.toHaveBeenCalled();
    expect(journeyAgg.fetchDimension).not.toHaveBeenCalled();
    expect(journeyAgg.fetchReminderRows).not.toHaveBeenCalled();
    expect(journeyAgg.fetchBranchLabels).not.toHaveBeenCalled();
    expect(journeyAgg.fetchStaffLabels).not.toHaveBeenCalled();
    expect(journeyAgg.fetchServiceLabels).not.toHaveBeenCalled();
  });

  it('a MISS reaches the aggregation engine for the overall row and every dimension', async () => {
    const { service, journeyAgg } = build();

    await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    // RANGE is 31 days (<= the 366-day comparison ceiling), so the prior period
    // IS requested: fetchOverall runs once for the current range and once more
    // for the prior one.
    expect(journeyAgg.fetchOverall).toHaveBeenCalledTimes(2);
    expect(journeyAgg.fetchDimension).toHaveBeenCalledTimes(5); // branch, staff, service, weekday, hour
    expect(journeyAgg.fetchReminderRows).toHaveBeenCalledTimes(1);
  });

  it('skips the prior-period query entirely above the comparison range ceiling', async () => {
    const { service, journeyAgg } = build();

    await service.summary(TENANT, TENANT_WIDE, {
      from: '2025-01-01',
      to: '2026-01-10',
    } as never); // 375 days: valid range, > 366-day comparison ceiling

    expect(journeyAgg.fetchOverall).toHaveBeenCalledTimes(1); // current range only, no prior
  });

  it('breakdown reuses the same cached aggregate — a hit after a summary hit runs nothing new', async () => {
    const { service, journeyAgg } = build({ cached: emptyAggregate() });

    await service.summary(TENANT, TENANT_WIDE, RANGE as never);
    await service.breakdown(TENANT, TENANT_WIDE, {
      ...RANGE,
      dimension: 'branch',
      sort: 'appointments',
      page: 1,
      limit: 20,
    } as never);

    expect(journeyAgg.fetchOverall).not.toHaveBeenCalled();
    expect(journeyAgg.fetchDimension).not.toHaveBeenCalled();
  });
});

describe('PatientJourneyService — authorization is never cached', () => {
  it('resolves branch scope BEFORE consulting the cache, even on a hit', async () => {
    const { service, branchScope } = build({ cached: emptyAggregate() });

    await service.summary(TENANT, BRANCH_RESTRICTED, RANGE as never);

    expect(branchScope.getMembershipBranchIds).toHaveBeenCalledTimes(1);
  });

  it('the cache key uses the RESOLVED branch/staff/service, not the raw request', async () => {
    const { service, cacheKeys } = build({ cached: emptyAggregate() });

    await service.summary(TENANT, BRANCH_RESTRICTED, {
      ...RANGE,
      staffId: 'staff-1',
      serviceId: 'svc-1',
    } as never);

    expect(cacheKeys[0]).toBe(
      `journey:${RANGE.from}:${RANGE.to}:branch-b:staff-1:svc-1`,
    );
  });

  it('a request for a branch outside membership is rejected before the cache is touched', async () => {
    const { service, cache } = build({ cached: emptyAggregate() });
    const wrapSpy = jest.spyOn(cache, 'wrap');

    await expect(
      service.summary(TENANT, BRANCH_RESTRICTED, {
        ...RANGE,
        branchId: 'some-other-branch',
      } as never),
    ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    expect(wrapSpy).not.toHaveBeenCalled();
  });
});

describe('PatientJourneyService — range validation (reused, not reimplemented)', () => {
  it('rejects from > to', async () => {
    const { service } = build();
    await expect(
      service.summary(TENANT, TENANT_WIDE, {
        from: '2026-08-31',
        to: '2026-08-01',
      } as never),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects a range wider than the shared MAX_ADVANCED_ANALYTICS_RANGE_DAYS bound', async () => {
    const { service } = build();
    await expect(
      service.summary(TENANT, TENANT_WIDE, {
        from: '2020-01-01',
        to: '2026-01-01',
      } as never),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('PatientJourneyService — breakdown paging/sorting', () => {
  function rowsAggregate(): JourneyAggregate {
    return emptyAggregate({
      byDimension: {
        branch: [
          {
            ...zeroRow(),
            dim_key: 'b1',
            booked: 100,
            wait_start_n: 40,
            wait_start_p50: 30,
          },
          {
            ...zeroRow(),
            dim_key: 'b2',
            booked: 50,
            wait_start_n: 40,
            wait_start_p50: 10,
          },
          {
            ...zeroRow(),
            dim_key: 'b3',
            booked: 200,
            wait_start_n: 40,
            wait_start_p50: 20,
          },
        ],
        staff: [],
        service: [],
        weekday: [],
        hour: [],
      },
      labels: {
        branch: {
          b1: { name: 'Branch 1', inactive: false, configuredMinutes: null },
          b2: { name: 'Branch 2', inactive: false, configuredMinutes: null },
          b3: { name: 'Branch 3', inactive: false, configuredMinutes: null },
        },
        staff: {},
        service: {},
      },
    });
  }

  it('sorts by appointments (default) descending', async () => {
    const { service } = build({ cached: rowsAggregate() });
    const res = await service.breakdown(TENANT, TENANT_WIDE, {
      ...RANGE,
      dimension: 'branch',
      sort: 'appointments',
      page: 1,
      limit: 20,
    } as never);
    expect(res.data.map((r) => r.key)).toEqual(['b3', 'b1', 'b2']);
    expect(res.total).toBe(3);
  });

  it('sorts by waitToStartP50 when requested', async () => {
    const { service } = build({ cached: rowsAggregate() });
    const res = await service.breakdown(TENANT, TENANT_WIDE, {
      ...RANGE,
      dimension: 'branch',
      sort: 'waitToStartP50',
      page: 1,
      limit: 20,
    } as never);
    expect(res.data.map((r) => r.key)).toEqual(['b1', 'b3', 'b2']);
  });

  it('paginates correctly', async () => {
    const { service } = build({ cached: rowsAggregate() });
    const res = await service.breakdown(TENANT, TENANT_WIDE, {
      ...RANGE,
      dimension: 'branch',
      sort: 'appointments',
      page: 2,
      limit: 2,
    } as never);
    expect(res.data).toHaveLength(1);
    expect(res.page).toBe(2);
    expect(res.total).toBe(3);
  });

  it('zero-fills weekday rows to all 7 days even with no data', async () => {
    const { service } = build({ cached: emptyAggregate() });
    const res = await service.breakdown(TENANT, TENANT_WIDE, {
      ...RANGE,
      dimension: 'weekday',
      sort: 'appointments',
      page: 1,
      limit: 20,
    } as never);
    expect(res.data).toHaveLength(7);
    expect(res.data.map((r) => r.key)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ]);
  });

  it('reports the excluded multi/no-service count only for the service dimension', async () => {
    const { service } = build({
      cached: emptyAggregate({
        overall: zeroRow({ multi_service: 5, no_service: 2 }),
      }),
    });
    const serviceRes = await service.breakdown(TENANT, TENANT_WIDE, {
      ...RANGE,
      dimension: 'service',
      sort: 'appointments',
      page: 1,
      limit: 20,
    } as never);
    expect(serviceRes.excluded).toEqual({ multiOrNoServiceAppointments: 7 });

    const branchRes = await service.breakdown(TENANT, TENANT_WIDE, {
      ...RANGE,
      dimension: 'branch',
      sort: 'appointments',
      page: 1,
      limit: 20,
    } as never);
    expect(branchRes.excluded).toBeNull();
  });
});
