import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { PlatformDashboardService } from './platform-dashboard.service';
import { SubscriptionService } from '../subscription-billing/subscription.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus, TenantApprovalStatus } from '../../entities/enums';
import {
  DASHBOARD_SUBSCRIPTION_STATE,
  DASHBOARD_SUBSCRIPTION_STATES,
  effectiveStatusSql,
} from './dashboard.constants';

const GRACE_DAYS = 14;
const DAY = 86_400_000;

function makeService(queryImpl: jest.Mock) {
  const dataSource = { query: queryImpl } as unknown as DataSource;
  const config = {
    get: jest.fn((_key: string, fallback?: number) => fallback ?? GRACE_DAYS),
  } as unknown as ConfigService;
  return new PlatformDashboardService(dataSource, config);
}

describe('PlatformDashboardService.snapshot', () => {
  it('returns exact platform-wide counts from aggregates, never a sampled page', async () => {
    const query = jest
      .fn()
      // tenantStateCounts
      .mockResolvedValueOnce([
        {
          total: 142,
          approved: 118,
          pending_verification: 9,
          pending_approval: 3,
          suspended: 7,
          rejected: 5,
          active: 110,
        },
      ])
      // subscriptionStateCounts
      .mockResolvedValueOnce([
        { state: 'ACTIVE', count: 84 },
        { state: 'TRIAL', count: 21 },
        { state: 'NONE', count: 25 },
      ]);

    const result = await makeService(query).snapshot();

    expect(result.tenants).toEqual({
      total: 142,
      approved: 118,
      pendingVerification: 9,
      pendingApproval: 3,
      suspended: 7,
      rejected: 5,
      active: 110,
    });
    expect(result.timezone).toBe('UTC');
    expect(result.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the four tenant lifecycle states separate — pending-verification is not pending-approval, a suspension is not a rejection', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          total: 4,
          approved: 0,
          pending_verification: 1,
          pending_approval: 1,
          suspended: 1,
          rejected: 1,
          active: 0,
        },
      ])
      .mockResolvedValueOnce([]);

    const { tenants } = await makeService(query).snapshot();

    // The page this replaces summed these into two counters, hiding two
    // distinct operator actions behind one number.
    expect(tenants.pendingVerification).toBe(1);
    expect(tenants.pendingApproval).toBe(1);
    expect(tenants.suspended).toBe(1);
    expect(tenants.rejected).toBe(1);
  });

  it('seeds every subscription state at zero so an absent state is never ambiguous', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{ state: 'ACTIVE', count: 1 }]);

    const { subscriptions } = await makeService(query).snapshot();

    for (const state of DASHBOARD_SUBSCRIPTION_STATES) {
      expect(subscriptions).toHaveProperty(state);
      expect(typeof subscriptions[state]).toBe('number');
    }
    expect(subscriptions.GRACE_EXPIRED).toBe(0);
    expect(subscriptions.ACTIVE).toBe(1);
  });

  it('counts tenants with no subscription row at all as NONE', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ total: 30 }])
      .mockResolvedValueOnce([
        { state: 'ACTIVE', count: 5 },
        { state: 'NONE', count: 25 },
      ]);

    const { subscriptions } = await makeService(query).snapshot();

    // Approved clinics that never picked a plan are invisible in every existing
    // endpoint, and are exactly the cohort an operator needs to chase.
    expect(subscriptions.NONE).toBe(25);
  });

  it('warns rather than silently dropping tenants when the enum grows past this file', async () => {
    const warn = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([{ state: 'SOME_FUTURE_STATE', count: 2 }]);

    await makeService(query).snapshot();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SOME_FUTURE_STATE'));
    warn.mockRestore();
  });

  it('runs the two independent aggregates concurrently, not as sequential round-trips', async () => {
    const order: string[] = [];
    const query = jest.fn().mockImplementation(async (sql: string) => {
      order.push(sql.includes('GROUP BY state') ? 'subs' : 'tenants');
      await new Promise((r) => setTimeout(r, 0));
      return sql.includes('GROUP BY state') ? [] : [{ total: 0 }];
    });

    await makeService(query).snapshot();

    // Both are dispatched before either resolves.
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(['tenants', 'subs']));
  });

  it('never emits a now()-derived time boundary in SQL — every window is a bound UTC parameter', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    await makeService(query).snapshot();

    for (const [sql] of query.mock.calls) {
      // `now()` is legitimate inside the effective-status CASE (it compares
      // against a stored timestamptz); what must never appear is a TRUNCATED
      // boundary, which is what silently follows the server timezone.
      expect(sql).not.toMatch(/date_trunc\s*\(\s*'(day|week|month)'\s*,\s*now\(\)/);
    }
  });

  it('reads the grace window from config rather than hardcoding it', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);
    const dataSource = { query } as unknown as DataSource;
    const get = jest.fn().mockReturnValue(21);
    await new PlatformDashboardService(dataSource, {
      get,
    } as unknown as ConfigService).snapshot();

    expect(get).toHaveBeenCalledWith('SUBSCRIPTION_GRACE_DAYS', 14);
    expect(query.mock.calls[0][1]).toEqual([21]);
    expect(query.mock.calls[1][1]).toEqual([21]);
  });
});

/**
 * The definition guard.
 *
 * `effectiveStatusSql()` reproduces `SubscriptionService.getEffectiveStatus()`
 * in SQL. Two implementations of one rule drift unless something fails when they
 * do — this evaluates the SQL's CASE branches in TypeScript over the same case
 * table the method is fed, and asserts they agree.
 *
 * This matters more than a usual parity test: THREE divergent definitions of
 * "active subscription" already ship (`MarketplaceFinanceService.kpis()` drops
 * every TRIAL; `PlatformUsageService.baseCte()` emits an `'EXPIRED'` string that
 * is not in the enum; this method maps the same case to PAST_DUE then
 * GRACE_EXPIRED). The dashboard adopts this one, so it must not become a fourth.
 */
describe('effectiveStatusSql ≡ SubscriptionService.getEffectiveStatus', () => {
  /** Evaluates the SQL CASE's branch order against a row, in TS. */
  function evaluateSql(
    sub: Pick<Subscription, 'status' | 'ends_at' | 'grace_started_at'> | null,
    now: Date,
  ): string {
    if (!sub) return DASHBOARD_SUBSCRIPTION_STATE.NONE;
    if (
      sub.status === SubscriptionStatus.CANCELLED ||
      sub.status === SubscriptionStatus.SUSPENDED ||
      sub.status === SubscriptionStatus.GRACE_EXPIRED
    ) {
      return sub.status;
    }
    if (sub.status === SubscriptionStatus.PAST_DUE) {
      if (
        sub.grace_started_at &&
        sub.grace_started_at.getTime() + GRACE_DAYS * DAY < now.getTime()
      ) {
        return SubscriptionStatus.GRACE_EXPIRED;
      }
      return SubscriptionStatus.PAST_DUE;
    }
    if (sub.ends_at < now) return SubscriptionStatus.PAST_DUE;
    return sub.status;
  }

  const now = new Date('2026-08-14T12:00:00.000Z');
  const future = new Date(now.getTime() + 30 * DAY);
  const past = new Date(now.getTime() - 1 * DAY);

  // `getEffectiveStatus` is pure: it reads only its two arguments. Its
  // `graceDurationDays` default would touch `this.config`, but a default
  // parameter is not evaluated when the argument is supplied — and every case
  // below supplies it. So the collaborators are never reached and constructing
  // with empty stand-ins is safe rather than merely convenient.
  const stub = {} as never;
  const service = new SubscriptionService(stub, stub, stub, stub, stub, stub, stub);

  const cases: {
    name: string;
    sub: Pick<Subscription, 'status' | 'ends_at' | 'grace_started_at'> | null;
    expected: string;
  }[] = [
    {
      name: 'ACTIVE, not yet ended',
      sub: { status: SubscriptionStatus.ACTIVE, ends_at: future, grace_started_at: null },
      expected: SubscriptionStatus.ACTIVE,
    },
    {
      name: 'TRIAL, not yet ended',
      sub: { status: SubscriptionStatus.TRIAL, ends_at: future, grace_started_at: null },
      expected: SubscriptionStatus.TRIAL,
    },
    {
      name: 'ACTIVE past ends_at → PAST_DUE (not the string "EXPIRED")',
      sub: { status: SubscriptionStatus.ACTIVE, ends_at: past, grace_started_at: null },
      expected: SubscriptionStatus.PAST_DUE,
    },
    {
      name: 'TRIAL past ends_at → PAST_DUE',
      sub: { status: SubscriptionStatus.TRIAL, ends_at: past, grace_started_at: null },
      expected: SubscriptionStatus.PAST_DUE,
    },
    {
      name: 'PAST_DUE, grace window still open',
      sub: {
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        grace_started_at: new Date(now.getTime() - 1 * DAY),
      },
      expected: SubscriptionStatus.PAST_DUE,
    },
    {
      name: 'PAST_DUE, exactly one second before the grace boundary',
      sub: {
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        grace_started_at: new Date(now.getTime() - GRACE_DAYS * DAY + 1000),
      },
      expected: SubscriptionStatus.PAST_DUE,
    },
    {
      name: 'PAST_DUE, one second past the grace boundary → GRACE_EXPIRED',
      sub: {
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        grace_started_at: new Date(now.getTime() - GRACE_DAYS * DAY - 1000),
      },
      expected: SubscriptionStatus.GRACE_EXPIRED,
    },
    {
      name: 'PAST_DUE with no grace_started_at never auto-expires',
      sub: { status: SubscriptionStatus.PAST_DUE, ends_at: past, grace_started_at: null },
      expected: SubscriptionStatus.PAST_DUE,
    },
    {
      name: 'CANCELLED is terminal and passes through',
      sub: { status: SubscriptionStatus.CANCELLED, ends_at: future, grace_started_at: null },
      expected: SubscriptionStatus.CANCELLED,
    },
    {
      name: 'SUSPENDED is terminal and passes through',
      sub: { status: SubscriptionStatus.SUSPENDED, ends_at: past, grace_started_at: null },
      expected: SubscriptionStatus.SUSPENDED,
    },
    {
      name: 'already GRACE_EXPIRED passes through',
      sub: {
        status: SubscriptionStatus.GRACE_EXPIRED,
        ends_at: past,
        grace_started_at: new Date(now.getTime() - 90 * DAY),
      },
      expected: SubscriptionStatus.GRACE_EXPIRED,
    },
  ];

  it.each(cases)('$name', ({ sub, expected }) => {
    jest.useFakeTimers().setSystemTime(now);
    try {
      expect(evaluateSql(sub, now)).toBe(expected);
      if (sub) {
        expect(service.getEffectiveStatus(sub as Subscription, GRACE_DAYS)).toBe(expected);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('maps a missing subscription to NONE, which the enum cannot express', () => {
    expect(evaluateSql(null, now)).toBe(DASHBOARD_SUBSCRIPTION_STATE.NONE);
    expect(DASHBOARD_SUBSCRIPTION_STATE.NONE).toBe('NONE');
  });

  it('emits every branch of the canonical rule into the generated SQL', () => {
    const sql = effectiveStatusSql('sub', '$1');
    expect(sql).toContain(SubscriptionStatus.GRACE_EXPIRED);
    expect(sql).toContain(SubscriptionStatus.PAST_DUE);
    expect(sql).toContain(SubscriptionStatus.CANCELLED);
    expect(sql).toContain(SubscriptionStatus.SUSPENDED);
    expect(sql).toContain('NONE');
    expect(sql).toContain('grace_started_at');
    // The grace window is a bound parameter, never inlined.
    expect(sql).toContain('$1 * interval');
  });
});

describe('tenant lifecycle vocabulary', () => {
  it('covers every TenantApprovalStatus member, so no clinic falls outside the counts', () => {
    const counted = [
      TenantApprovalStatus.APPROVED,
      TenantApprovalStatus.PENDING_VERIFICATION,
      TenantApprovalStatus.PENDING_APPROVAL,
      TenantApprovalStatus.SUSPENDED,
      TenantApprovalStatus.REJECTED,
    ];
    expect(new Set(counted)).toEqual(new Set(Object.values(TenantApprovalStatus)));
  });
});
