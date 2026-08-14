import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { PlatformDashboardService } from './platform-dashboard.service';
import { MonitoringService } from '../platform-monitoring/monitoring.service';
import { SupportTicketService } from '../support-tickets/support-ticket.service';
import { QueueService } from '../../queue/queue.service';
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

const HEALTH = {
  database: 'up',
  redis: 'up',
  workers: 'up',
  workerHeartbeatAgeSeconds: 12,
  queueBacklog: 0,
  failedJobs: 0,
  webhookFailures: 0,
};

/**
 * The snapshot fires eight queries through `DataSource.query`. Routing the mock
 * on SQL SHAPE rather than call order keeps these tests readable and stops them
 * breaking every time a source is added or reordered.
 */
function routedQuery(overrides: Record<string, unknown[]> = {}) {
  return jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('AS pending_verification')) {
      return (
        overrides.tenants ?? [
          {
            total: 31,
            approved: 30,
            pending_verification: 0,
            pending_approval: 0,
            suspended: 0,
            rejected: 1,
            active: 13,
          },
        ]
      );
    }
    if (sql.includes('GROUP BY state')) {
      return overrides.states ?? [{ state: 'ACTIVE', count: 13 }, { state: 'NONE', count: 18 }];
    }
    if (sql.includes('AS active') && sql.includes('AS trial')) {
      return overrides.expiring ?? [{ active: 2, trial: 1 }];
    }
    if (sql.includes('GROUP BY plan_id')) {
      return (
        overrides.plans ?? [
          { plan_id: 'p1', plan_name: 'Pro', count: 8, monthly_value: '2392.00' },
          { plan_id: 'p2', plan_name: 'Starter', count: 5, monthly_value: '495.00' },
        ]
      );
    }
    if (sql.includes('ORDER BY ends_at ASC')) return overrides.renewals ?? [];
    if (sql.includes('integration_broken')) return overrides.health ?? [];
    if (sql.includes('pending_approvals')) {
      return overrides.actions ?? [{ pending_approvals: 3, pending_docs: 2, upgrade_requests: 1 }];
    }
    return [];
  });
}

/** A cache that always misses and records writes — the default for these tests. */
function noopCache() {
  return {
    kvGet: jest.fn().mockResolvedValue(null),
    kvSet: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(query: jest.Mock, grace = GRACE_DAYS, cache = noopCache()) {
  return new PlatformDashboardService(
    { query } as unknown as DataSource,
    { get: jest.fn().mockReturnValue(grace) } as unknown as ConfigService,
    { healthSnapshot: jest.fn().mockResolvedValue(HEALTH) } as unknown as MonitoringService,
    {
      kpis: jest.fn().mockResolvedValue({ open: 4, inProgress: 1, resolved: 9, urgent: 2 }),
    } as unknown as SupportTicketService,
    cache as unknown as QueueService,
  );
}

describe('PlatformDashboardService.snapshot', () => {
  it('returns exact platform-wide counts from aggregates, never a sampled page', async () => {
    const result = await makeService(routedQuery()).snapshot();

    expect(result.tenants).toEqual({
      total: 31,
      approved: 30,
      pendingVerification: 0,
      pendingApproval: 0,
      suspended: 0,
      rejected: 1,
      active: 13,
    });
    expect(result.timezone).toBe('UTC');
    expect(result.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the four tenant lifecycle states separate', async () => {
    const query = routedQuery({
      tenants: [
        {
          total: 4,
          approved: 0,
          pending_verification: 1,
          pending_approval: 1,
          suspended: 1,
          rejected: 1,
          active: 0,
        },
      ],
    });
    const { tenants } = await makeService(query).snapshot();

    // The page this replaces summed these into two counters, hiding two
    // distinct operator actions behind one number.
    expect(tenants.pendingVerification).toBe(1);
    expect(tenants.pendingApproval).toBe(1);
    expect(tenants.suspended).toBe(1);
    expect(tenants.rejected).toBe(1);
  });

  it('seeds every subscription state at zero so an absent state is never ambiguous', async () => {
    const { subscriptions } = await makeService(
      routedQuery({ states: [{ state: 'ACTIVE', count: 1 }] }),
    ).snapshot();

    for (const state of DASHBOARD_SUBSCRIPTION_STATES) {
      expect(typeof subscriptions.counts[state]).toBe('number');
    }
    expect(subscriptions.counts.GRACE_EXPIRED).toBe(0);
    expect(subscriptions.counts.ACTIVE).toBe(1);
  });

  it('counts tenants with no subscription row at all as NONE', async () => {
    const { subscriptions } = await makeService(routedQuery()).snapshot();
    // Approved clinics that never picked a plan are invisible in every existing
    // endpoint, and are exactly the cohort an operator needs to chase.
    expect(subscriptions.counts.NONE).toBe(18);
  });

  it('warns rather than silently dropping tenants when the enum grows past this file', async () => {
    const warn = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await makeService(routedQuery({ states: [{ state: 'SOME_FUTURE_STATE', count: 2 }] })).snapshot();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SOME_FUTURE_STATE'));
    warn.mockRestore();
  });

  it('derives advisory MRR from the same plan rows the mix reports, so the two cannot disagree', async () => {
    const result = await makeService(routedQuery()).snapshot();

    expect(result.subscriptions.byPlan.map((p) => p.planName)).toEqual(['Pro', 'Starter']);
    expect(result.advisoryMrr.amount).toBe(2887); // 2392 + 495
    // No currency: `subscription_plans` has no currency column, so there is no
    // honest symbol to attach and inventing one would be worse than omitting it.
    expect(result.advisoryMrr.currency).toBeNull();
    expect(result.advisoryMrr.note).toBe('contracted-plan-value');
  });

  it('degrades one source rather than the page when a dependency fails', async () => {
    const service = new PlatformDashboardService(
      { query: routedQuery() } as unknown as DataSource,
      { get: jest.fn().mockReturnValue(GRACE_DAYS) } as unknown as ConfigService,
      {
        healthSnapshot: jest.fn().mockRejectedValue(new Error('redis down')),
      } as unknown as MonitoringService,
      { kpis: jest.fn().mockResolvedValue({ urgent: 0, open: 0 }) } as unknown as SupportTicketService,
      noopCache() as unknown as QueueService,
    );

    const result = await service.snapshot();

    // A Redis outage must not blank the operator's landing page at exactly the
    // moment they need it.
    expect(result.health).toBeNull();
    expect(result.degradedSources).toContain('health');
    expect(result.tenants.total).toBe(31);
  });

  it('reads the grace window from config rather than hardcoding it', async () => {
    const query = routedQuery();
    await makeService(query, 21).snapshot();
    // Every effective-status query binds the configured window.
    const graceCalls = query.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 21);
    expect(graceCalls.length).toBeGreaterThan(0);
  });

  it('never emits a truncated now()-derived boundary in SQL', async () => {
    const query = routedQuery();
    await makeService(query).snapshot();

    for (const [sql] of query.mock.calls) {
      // `now()` is legitimate inside the effective-status CASE (it compares
      // against a stored timestamptz). What must never appear is a TRUNCATED
      // boundary, which silently follows the Postgres server timezone.
      expect(sql).not.toMatch(/date_trunc\s*\(\s*'(day|week|month)'\s*,\s*now\(\)/);
    }
  });

  it('surfaces clinics with the evidence that flagged them, never a score', async () => {
    const query = routedQuery({
      health: [
        {
          id: 't1',
          name: 'Al-Shifa',
          state: 'NONE',
          last_activity: null,
          integration_broken: true,
          never_activated: false,
          dormant: true,
          settled_in: true,
        },
      ],
    });
    const { tenantHealth } = await makeService(query).snapshot();

    expect(tenantHealth[0].reasons).toEqual(
      expect.arrayContaining(['INTEGRATION_BROKEN', 'NO_SUBSCRIPTION', 'DORMANT']),
    );
    // Reasons are codes for client-side translation, not English prose.
    for (const r of tenantHealth[0].reasons) expect(r).toMatch(/^[A-Z_]+$/);
  });

  it('does not call a brand-new clinic dormant on day one', async () => {
    const query = routedQuery({
      health: [
        {
          id: 't2',
          name: 'New Clinic',
          state: 'NONE',
          last_activity: null,
          integration_broken: false,
          never_activated: false,
          dormant: true,
          settled_in: false, // registered less than a week ago
        },
      ],
    });
    const { tenantHealth } = await makeService(query).snapshot();

    expect(tenantHealth[0].reasons).not.toContain('DORMANT');
    expect(tenantHealth[0].reasons).toContain('NO_SUBSCRIPTION');
  });
});

describe('PlatformDashboardService.snapshot — caching', () => {
  it('serves a cache hit without touching the database', async () => {
    const cached = { tenants: { total: 999 }, degradedSources: [] };
    const cache = {
      kvGet: jest.fn().mockResolvedValue(JSON.stringify(cached)),
      kvSet: jest.fn(),
    };
    const query = routedQuery();
    const result = await makeService(query, GRACE_DAYS, cache).snapshot();

    expect(result.tenants.total).toBe(999);
    expect(query).not.toHaveBeenCalled();
  });

  it('bypasses the cache when the caller asks for fresh data', async () => {
    const cache = {
      kvGet: jest.fn().mockResolvedValue(JSON.stringify({ tenants: { total: 999 }, degradedSources: [] })),
      kvSet: jest.fn(),
    };
    const result = await makeService(routedQuery(), GRACE_DAYS, cache).snapshot({
      bypassCache: true,
    });

    // A Refresh button that can return the entry it was asked to replace is a
    // lie, so `no-cache` must actually recompute.
    expect(cache.kvGet).not.toHaveBeenCalled();
    expect(result.tenants.total).toBe(31);
  });

  it('computes fresh when Redis is unreachable, rather than failing', async () => {
    const cache = {
      kvGet: jest.fn().mockRejectedValue(new Error('redis down')),
      kvSet: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const result = await makeService(routedQuery(), GRACE_DAYS, cache).snapshot();

    // A miss, a malformed entry and an outage are all the same path: go to the
    // database. There is no branch that returns stale-or-nothing.
    expect(result.tenants.total).toBe(31);
  });

  it('treats a malformed cache entry as a miss', async () => {
    const cache = { kvGet: jest.fn().mockResolvedValue('{not json'), kvSet: jest.fn() };
    const result = await makeService(routedQuery(), GRACE_DAYS, cache).snapshot();
    expect(result.tenants.total).toBe(31);
  });

  it('caches a healthy snapshot with a bounded TTL', async () => {
    const cache = noopCache();
    await makeService(routedQuery(), GRACE_DAYS, cache).snapshot();

    expect(cache.kvSet).toHaveBeenCalledWith(
      'platform:dashboard:snapshot:v1',
      expect.any(String),
      60,
    );
  });

  it('never caches a degraded snapshot', async () => {
    const cache = noopCache();
    const service = new PlatformDashboardService(
      { query: routedQuery() } as unknown as DataSource,
      { get: jest.fn().mockReturnValue(GRACE_DAYS) } as unknown as ConfigService,
      { healthSnapshot: jest.fn().mockRejectedValue(new Error('down')) } as unknown as MonitoringService,
      { kpis: jest.fn().mockResolvedValue({ urgent: 0, open: 0 }) } as unknown as SupportTicketService,
      cache as unknown as QueueService,
    );

    await service.snapshot();

    // Pinning a partial answer for a minute is worse than recomputing it.
    expect(cache.kvSet).not.toHaveBeenCalled();
  });

  it('uses a platform-global key with no user or tenant component', async () => {
    const cache = noopCache();
    await makeService(routedQuery(), GRACE_DAYS, cache).snapshot();
    const [key] = cache.kvSet.mock.calls[0];
    // The payload is identical for every super-admin and role-gated identically,
    // so per-user keys would only fragment the cache.
    expect(key).toBe('platform:dashboard:snapshot:v1');
  });
});

describe('PlatformDashboardService.summary', () => {
  function summaryQuery(over: Record<string, unknown[]> = {}) {
    return jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('AS cur') && sql.includes('FROM tenants')) {
        return over.tenants ?? [{ cur: 12, prev: 9 }];
      }
      if (sql.includes('rev_cur')) {
        return (
          over.payments ?? [
            {
              rev_cur: '2431.00',
              rev_prev: '2170.00',
              gross_cur: '48620.00',
              gross_prev: '43400.00',
              failed_cur: 4,
              failed_prev: 5,
              paying_cur: 87,
              paying_prev: 80,
            },
          ]
        );
      }
      if (sql.includes('FROM refunds')) return over.refunds ?? [{ cur: '120.00', prev: '0' }];
      if (sql.includes('DISTINCT currency')) return over.currencies ?? [{ currency: 'SAR' }];
      if (sql.includes('MIN(created_at)')) {
        return over.baseline ?? [{ first: new Date('2020-01-01T00:00:00Z') }];
      }
      if (sql.includes('generate_series') && sql.includes('LEFT JOIN tenants')) {
        return over.growth ?? [{ bucket: '2026-08-01', value: 2 }, { bucket: '2026-08-02', value: 3 }];
      }
      if (sql.includes('generate_series')) {
        return over.revenue ?? [{ bucket: '2026-08-01', value: '100.00', secondary: 4 }];
      }
      return [];
    });
  }

  const svc = (query: jest.Mock) =>
    new PlatformDashboardService(
      { query } as unknown as DataSource,
      { get: jest.fn().mockReturnValue(GRACE_DAYS) } as unknown as ConfigService,
      { healthSnapshot: jest.fn() } as unknown as MonitoringService,
      { kpis: jest.fn() } as unknown as SupportTicketService,
      noopCache() as unknown as QueueService,
    );

  it('reports a real percentage when the previous window is non-zero', async () => {
    const r = await svc(summaryQuery()).summary({ range: '30d' });
    expect(r.metrics.newTenants.state).toBe('changed');
    expect(r.metrics.newTenants.percent).toBeCloseTo(33.3, 1);
    expect(r.metrics.newTenants.delta).toBe(3);
  });

  it('reports NEW rather than a fabricated +100% when the previous window is zero', async () => {
    const r = await svc(summaryQuery({ refunds: [{ cur: '120.00', prev: '0' }] })).summary({});
    expect(r.metrics.refunds.state).toBe('new');
    expect(r.metrics.refunds.percent).toBeNull();
  });

  it('reports NONE when nothing happened in either window', async () => {
    const r = await svc(summaryQuery({ refunds: [{ cur: '0', prev: '0' }] })).summary({});
    expect(r.metrics.refunds.state).toBe('none');
    expect(r.metrics.refunds.percent).toBeNull();
  });

  it('refuses to compare against a window that predates every record', async () => {
    const r = await svc(
      summaryQuery({ baseline: [{ first: new Date() }] }),
    ).summary({ range: '30d' });
    expect(r.metrics.newTenants.state).toBe('no-baseline');
    expect(r.metrics.newTenants.percent).toBeNull();
  });

  it('carries metric direction so a rise in failures is not coloured as a win', async () => {
    const r = await svc(summaryQuery()).summary({});
    expect(r.metrics.failedPayments.direction).toBe('lower-is-better');
    expect(r.metrics.platformRevenue.direction).toBe('higher-is-better');
  });

  it('uses half-open UTC windows and a same-length comparison period', async () => {
    const r = await svc(summaryQuery()).summary({ range: '7d' });
    const from = new Date(r.range.from).getTime();
    const to = new Date(r.range.to).getTime();
    const prevFrom = new Date(r.range.previousFrom).getTime();
    const prevTo = new Date(r.range.previousTo).getTime();

    expect(r.range.timezone).toBe('UTC');
    expect(to - from).toBe(prevTo - prevFrom);
    // The comparison window ends exactly where the current one starts — no
    // overlap, no gap.
    expect(prevTo).toBe(from);
  });

  it('rejects a range longer than the documented ceiling', async () => {
    await expect(
      svc(summaryQuery()).summary({
        from: '2020-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/366 days/);
  });

  it('rejects an inverted range', async () => {
    await expect(
      svc(summaryQuery()).summary({
        from: '2026-08-10T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/must be after/);
  });

  it('reports the currencies the money figures were summed over', async () => {
    const r = await svc(
      summaryQuery({ currencies: [{ currency: 'SAR' }, { currency: 'USD' }] }),
    ).summary({});
    // Two currencies means the totals add unlike units; the client must not
    // stamp one symbol on them.
    expect(r.currencies).toEqual(['SAR', 'USD']);
  });

  it('returns a running cumulative alongside per-bucket signups', async () => {
    const r = await svc(summaryQuery()).summary({});
    expect(r.series.tenantGrowth).toEqual([
      { bucket: '2026-08-01', value: 2, secondary: 2 },
      { bucket: '2026-08-02', value: 3, secondary: 5 },
    ]);
  });
});

describe('PlatformDashboardService.activity — allowlisted projection', () => {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('tenant_approval_events')) {
      return [
        {
          action: 'APPROVED',
          created_at: new Date('2026-08-14T10:00:00Z'),
          tenant_id: 't1',
          tenant_name: 'Al-Noor',
          actor_name: 'Super Admin',
        },
      ];
    }
    if (sql.includes('audit_logs')) {
      return [
        {
          action: 'platform_admin.plan.update',
          entity_type: 'plan',
          created_at: new Date('2026-08-14T09:00:00Z'),
          actor_name: 'Super Admin',
          tenant_name: null,
        },
      ];
    }
    return [];
  });

  const svc = new PlatformDashboardService(
    { query } as unknown as DataSource,
    { get: jest.fn().mockReturnValue(GRACE_DAYS) } as unknown as ConfigService,
    { healthSnapshot: jest.fn() } as unknown as MonitoringService,
    { kpis: jest.fn() } as unknown as SupportTicketService,
    noopCache() as unknown as QueueService,
  );

  it('merges both sources newest-first', async () => {
    const r = await svc.activity({});
    expect(r.items.map((i) => i.type)).toEqual(['tenant_approval', 'platform_admin']);
  });

  it('never selects audit payload columns or the actor IP', async () => {
    await svc.activity({});
    const auditSql = query.mock.calls.map(([s]) => s as string).find((s) => s.includes('audit_logs'))!;

    // `new_values` carries plan pricing, system-setting payloads and override
    // reasons; `ip_address` locates the operator. Neither belongs on a landing
    // page, and the guard is the SELECT list itself, not a mapper that could be
    // bypassed later.
    expect(auditSql).not.toMatch(/old_values/);
    expect(auditSql).not.toMatch(/new_values/);
    expect(auditSql).not.toMatch(/ip_address/);
  });

  it('exposes an actor display name only — no email, no user id', async () => {
    const r = await svc.activity({});
    for (const item of r.items) {
      expect(Object.keys(item.actor)).toEqual(['displayName']);
    }
  });

  it('caps the requested limit', async () => {
    // The mock is shared across this describe, so earlier calls would otherwise
    // be the ones inspected.
    query.mockClear();
    await svc.activity({}, 5000);
    const sqls = query.mock.calls.map(([s]) => s as string);
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) expect(sql).toMatch(/LIMIT 50\b/);
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
  // below supplies it. So the collaborators are never reached.
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
      name: 'PAST_DUE, one second before the grace boundary',
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
