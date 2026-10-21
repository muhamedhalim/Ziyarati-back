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
      timezone: 'UTC',
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
    fetchActiveServiceCount: jest.fn().mockResolvedValue(3),
    assertStaff: jest.fn().mockResolvedValue(undefined),
    assertService: jest.fn().mockResolvedValue(undefined),
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
      // Only the (tiny) reporting-timezone lookup may go through it.
      wrap: (_tenant: string, _ns: string, key: string) =>
        key === 'reporting-timezone'
          ? Promise.resolve('UTC')
          : Promise.reject(
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

describe('PatientJourneyService — staff/service drill-down validation', () => {
  it('validates staff and service ids on a cache MISS, tenant-scoped', async () => {
    const { service, journeyAgg } = build();

    await service.summary(TENANT, TENANT_WIDE, {
      ...RANGE,
      staffId: 'staff-1',
      serviceId: 'svc-1',
    } as never);

    expect(journeyAgg.assertStaff).toHaveBeenCalledWith(TENANT, 'staff-1');
    expect(journeyAgg.assertService).toHaveBeenCalledWith(TENANT, 'svc-1');
  });

  it('does not validate when no drill-down id is supplied', async () => {
    const { service, journeyAgg } = build();

    await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    expect(journeyAgg.assertStaff).not.toHaveBeenCalled();
    expect(journeyAgg.assertService).not.toHaveBeenCalled();
  });

  it('a cache HIT stays free of extra reads (it was validated when computed)', async () => {
    const { service, journeyAgg } = build({ cached: emptyAggregate() });

    await service.summary(TENANT, TENANT_WIDE, {
      ...RANGE,
      staffId: 'staff-1',
      serviceId: 'svc-1',
    } as never);

    expect(journeyAgg.assertStaff).not.toHaveBeenCalled();
    expect(journeyAgg.assertService).not.toHaveBeenCalled();
  });

  it('an unknown/foreign staff id is rejected and no aggregation query runs', async () => {
    const { service, journeyAgg } = build();
    journeyAgg.assertStaff.mockRejectedValueOnce(
      new AppError(ErrorCode.NOT_FOUND, { message: 'Staff not found' }),
    );

    await expect(
      service.summary(TENANT, TENANT_WIDE, {
        ...RANGE,
        staffId: 'someone-elses-staff',
      } as never),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(journeyAgg.fetchOverall).not.toHaveBeenCalled();
  });

  it('an unknown/foreign service id is rejected and no aggregation query runs', async () => {
    const { service, journeyAgg } = build();
    journeyAgg.assertService.mockRejectedValueOnce(
      new AppError(ErrorCode.NOT_FOUND, { message: 'Service not found' }),
    );

    await expect(
      service.summary(TENANT, TENANT_WIDE, {
        ...RANGE,
        serviceId: 'someone-elses-service',
      } as never),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(journeyAgg.fetchOverall).not.toHaveBeenCalled();
  });
});

describe('PatientJourneyService — duration suggestion explanation in the summary', () => {
  it('reads the tenant service count in the same parallel batch as the label lookups', async () => {
    const { service, journeyAgg } = build();

    await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    expect(journeyAgg.fetchActiveServiceCount).toHaveBeenCalledTimes(1);
    expect(journeyAgg.fetchActiveServiceCount).toHaveBeenCalledWith(TENANT);
  });

  it('exposes NO_SERVICES_CONFIGURED when the tenant has no active service', async () => {
    const { service, journeyAgg } = build();
    journeyAgg.fetchActiveServiceCount.mockResolvedValueOnce(0);

    const out = await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    expect(out.durationSuggestionsState).toBe('NO_SERVICES_CONFIGURED');
    expect(out.durationSuggestionCandidates).toEqual([]);
    expect(out.durationSuggestions).toEqual([]);
  });

  it('exposes NO_SERVICE_APPOINTMENTS when services exist but none was booked in range', async () => {
    const { service } = build();

    const out = await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    expect(out.durationSuggestionsState).toBe('NO_SERVICE_APPOINTMENTS');
  });

  it('a blob cached before the field existed never asserts "no services configured"', async () => {
    const legacy = emptyAggregate(); // no activeServiceCount, like an old blob
    const { service } = build({ cached: legacy });

    const out = await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    expect(out.durationSuggestionsState).toBe('NO_SERVICE_APPOINTMENTS');
  });

  it('exposes the minimum duration sample so the client never hardcodes it', async () => {
    const { service } = build({ cached: emptyAggregate() });

    const out = await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    expect(out.thresholds.minDurationSample).toBe(20);
  });

  it('reports an in-range service that is still short of the sample as INSUFFICIENT_SAMPLE with its n', async () => {
    const svc = {
      ...zeroRow(),
      dim_key: 'svc-1',
      completed: 12,
      completed_with_timing: 12,
      consult_n: 12,
      consult_p75: 45,
    };
    const { service } = build({
      cached: emptyAggregate({
        byDimension: {
          branch: [],
          staff: [],
          service: [svc],
          weekday: [],
          hour: [],
        },
        labels: {
          branch: {},
          staff: {},
          service: {
            'svc-1': {
              name: 'Dentistry',
              inactive: false,
              configuredMinutes: 30,
            },
          },
        },
        activeServiceCount: 2,
      }),
    });

    const out = await service.summary(TENANT, TENANT_WIDE, RANGE as never);

    expect(out.durationSuggestions).toEqual([]);
    expect(out.durationSuggestionsState).toBeNull();
    expect(out.durationSuggestionCandidates).toHaveLength(1);
    expect(out.durationSuggestionCandidates[0]).toMatchObject({
      serviceId: 'svc-1',
      name: 'Dentistry',
      status: 'INSUFFICIENT_SAMPLE',
      configuredMinutes: 30,
      consultation: { n: 12, p50: null, p75: null },
    });
  });
});
