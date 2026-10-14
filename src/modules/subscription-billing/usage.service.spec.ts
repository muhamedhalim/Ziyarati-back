import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UsageService } from './usage.service';
import { AccessControlService } from './access-control.service';
import { TenantUsageLimitOverrideService } from './tenant-usage-limit-override.service';
import { TenantEntitlementLedgerService } from './tenant-entitlement-ledger.service';
import { TenantMetricCreditsService } from './tenant-metric-credits.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { User } from '../../entities/Auth&RBAC/User';
import { USAGE_METRIC, COUNT_LIMIT } from './usage-metric';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
  createMockQueryBuilder,
  createMockEntityManager,
} from '../../../test/utils/mock-factories';

describe('UsageService', () => {
  let service: UsageService;
  let subscriptions: MockRepository;
  let usageRepo: MockRepository;
  let access: { isEnforced: jest.Mock; assertAccess: jest.Mock };
  let limitOverrides: { getActive: jest.Mock; getActiveMap: jest.Mock };
  let ledger: { capacityMap: jest.Mock };
  let credits: { tryDebit: jest.Mock; balanceMap: jest.Mock; settle: jest.Mock; refundReservation: jest.Mock };
  let platformSettings: { getTyped: jest.Mock };

  /** The platform's standard access-denied error, as `assertAccess` raises it. */
  const denied = () =>
    Object.assign(new Error('no access'), {
      code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
    });

  beforeEach(async () => {
    subscriptions = createMockRepository();
    // T045 (015-db-api-efficiency-audit, P7-2/ORM-001): findCurrentSubscriptionWithPlan
    // now reads the tenant FK column via entity metadata (R-11 — Subscription
    // exposes no plain `tenantId` property), the same
    // `.metadata.findRelationWithPropertyPath` pattern used elsewhere in this
    // audit. `tenantId` matches the real column name (BaselineSchema
    // migration: `subscriptions."tenantId"`).
    (subscriptions as unknown as { metadata: unknown }).metadata = {
      name: 'Subscription',
      findRelationWithPropertyPath: (path: string) =>
        path === 'tenant' ? { joinColumns: [{ databaseName: 'tenantId' }] } : undefined,
    };
    usageRepo = createMockRepository();
    access = {
      isEnforced: jest.fn().mockResolvedValue(true),
      // Default: access IS allowed. A denial is programmed per-test.
      assertAccess: jest.fn().mockResolvedValue({ allowed: true }),
    };
    // No active override in any existing scenario — preserves prior behavior.
    limitOverrides = {
      getActive: jest.fn().mockResolvedValue(null),
      getActiveMap: jest.fn().mockResolvedValue(new Map()),
    };
    // No purchased capacity/credits in any existing scenario — Phase 1.4's
    // additive terms default to their pre-Phase-1 no-op state (empty map =>
    // `?? 0`), so every pre-existing test's expected numbers are unchanged.
    ledger = { capacityMap: jest.fn().mockResolvedValue(new Map()) };
    credits = {
      settle: jest.fn().mockResolvedValue({ debitedUnits: 0, overshootUnits: 0 }),
      refundReservation: jest.fn().mockResolvedValue(0),
      tryDebit: jest.fn().mockResolvedValue(false),
      balanceMap: jest.fn().mockResolvedValue(new Map()),
    };
    platformSettings = { getTyped: jest.fn().mockResolvedValue(5) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: getRepositoryToken(SubscriptionUsage), useValue: usageRepo },
        { provide: AccessControlService, useValue: access },
        { provide: TenantUsageLimitOverrideService, useValue: limitOverrides },
        { provide: TenantEntitlementLedgerService, useValue: ledger },
        { provide: TenantMetricCreditsService, useValue: credits },
        { provide: SystemSettingService, useValue: platformSettings },
      ],
    }).compile();
    service = moduleRef.get(UsageService);
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * T045 (015-db-api-efficiency-audit, P7-2): `findCurrentSubscriptionWithPlan`
   * now reads via `createQueryBuilder().getOne()`, not `findOne()` — but this
   * file also exercises `findCurrentSubscription` (a separate, still-`findOne`-
   * based private method, e.g. via `increment`/`release`), and many existing
   * tests don't know or care which one their code path actually uses. These
   * helpers prime BOTH mechanisms with the same row for exactly the next call,
   * so every pre-existing `subscriptions.findOne.mockResolvedValueOnce(...)` /
   * `mockResolvedValue(...)` call site keeps working unchanged regardless of
   * which private method it happens to exercise.
   */
  function mockCurrentSubscriptionOnce(row: unknown) {
    subscriptions.findOne.mockResolvedValueOnce(row as never);
    const qb = createMockQueryBuilder();
    qb.getOne = jest.fn().mockResolvedValue(row);
    subscriptions.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }

  function mockCurrentSubscriptionAlways(row: unknown) {
    subscriptions.findOne.mockResolvedValue(row as never);
    const qb = createMockQueryBuilder();
    qb.getOne = jest.fn().mockResolvedValue(row);
    subscriptions.createQueryBuilder.mockReturnValue(qb);
    return qb;
  }

  describe('increment', () => {
    it('is a no-op for a non-positive amount', async () => {
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 0);
      expect(usageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('RECORDS usage even when enforcement is off (free mode / override)', async () => {
      // "No plan cap applies" is not "do not count". This used to return early,
      // so the platform recorded nothing for exactly the tenants nobody was
      // billing — the operator's usage view read zero for every clinic running
      // on a super-admin grant. `incrementIfWithinLimit` already recorded on
      // this branch; the two now agree.
      access.isEnforced.mockResolvedValueOnce(false);
      mockCurrentSubscriptionOnce(null);
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 1);
      // insert(orIgnore) + update => two query builders
      expect(usageRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('still records usage when the tenant has no subscription', async () => {
      // Previously this returned early, so a clinic running on a super-admin
      // feature grant produced no usage rows at all and the platform was blind
      // to what it consumed. There is no plan to CAP it against, but that is a
      // reason not to enforce — not a reason not to count.
      mockCurrentSubscriptionOnce(null);
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 1);
      // insert(orIgnore) + update => two query builders
      expect(usageRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('upserts then atomically increments the metric', async () => {
      mockCurrentSubscriptionOnce({ id: 'sub-1' });
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 2);
      // insert(orIgnore) + update => two query builders
      expect(usageRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });
  });

  describe('assertWithinLimit', () => {
    it('is a no-op when enforcement is off', async () => {
      access.isEnforced.mockResolvedValueOnce(false);
      await expect(
        service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS),
      ).resolves.toBeUndefined();
      expect(subscriptions.findOne).not.toHaveBeenCalled();
    });

    it('allows unlimited metrics (null plan limit)', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_appointments: null },
      });
      await expect(
        service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS),
      ).resolves.toBeUndefined();
    });

    it('allows when usage stays within the plan limit', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_appointments: 100 },
      });
      usageRepo.findOne.mockResolvedValueOnce({ appointments_used: 50 });
      await expect(
        service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS, 10),
      ).resolves.toBeUndefined();
    });

    it('throws 422 when the increment would exceed the limit', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_appointments: 100 },
      });
      usageRepo.findOne.mockResolvedValueOnce({ appointments_used: 100 });
      await expect(
        service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS, 1),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('assertCountWithinLimit', () => {
    it('throws 422 when adding would exceed the absolute cap', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_users: 5 },
      });
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 5),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('allows an unlimited count cap (null)', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_users: null },
      });
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 999),
      ).resolves.toBeUndefined();
    });

    // Phase 1.4 (closes G2) — this method used to read ONLY the bare plan
    // column, so a paid "+1 branch" add-on displayed correctly in the usage
    // view but still 422'd here.
    it('honors purchased CAPACITY on top of the plan limit', async () => {
      mockCurrentSubscriptionAlways({
        id: 'sub-1',
        plan: { max_branches: 5 },
      });
      ledger.capacityMap.mockResolvedValue(new Map([['branches', 2]]));
      // effective limit = 5 (plan) + 2 (capacity) = 7. At 6 existing, +1 more fits.
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.BRANCHES, 6),
      ).resolves.toBeUndefined();
      // At 7 existing, +1 more would be the 8th — over the effective limit.
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.BRANCHES, 7),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('honors an active OVERRIDE on top of the plan limit', async () => {
      mockCurrentSubscriptionAlways({
        id: 'sub-1',
        plan: { max_branches: 5 },
      });
      limitOverrides.getActive.mockResolvedValue({ override_limit: '10' });
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.BRANCHES, 9),
      ).resolves.toBeUndefined();
    });

    it('asks the ledger for the correct capacity METRIC derived from the column', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_branches: 5 },
      });
      await service.assertCountWithinLimit('t1', COUNT_LIMIT.BRANCHES, 1);
      expect(limitOverrides.getActive).toHaveBeenCalledWith('t1', 'branches');
      expect(ledger.capacityMap).toHaveBeenCalledWith('t1');
    });
  });

  // T045 (015-db-api-efficiency-audit, P7-2/ORM-001): findCurrentSubscriptionWithPlan
  // exercised directly through assertCountWithinLimit, the simplest public
  // wrapper — the mandatory per-site assertion set (identical result, empty
  // for non-match, empty for a foreign tenant, soft-delete exclusion left to
  // TypeORM rather than hand-written, statement count).
  describe('findCurrentSubscriptionWithPlan — T045 (P7-2, ORM-001)', () => {
    it('resolves an unlimited cap identically to before (a matching row)', async () => {
      mockCurrentSubscriptionOnce({ id: 'sub-1', plan: { max_users: null } });
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 999),
      ).resolves.toBeUndefined();
    });

    it('no subscription (empty result) → allowed, no plan to compare against', async () => {
      mockCurrentSubscriptionOnce(null);
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 999),
      ).resolves.toBeUndefined();
    });

    it('scopes strictly by the FK column resolved from metadata — a foreign tenant id never widens the filter', async () => {
      const qb = mockCurrentSubscriptionOnce(null);
      await service.assertCountWithinLimit('other-tenant', COUNT_LIMIT.USERS, 1);
      expect(qb.where).toHaveBeenCalledWith('s."tenantId" = :tenantId', {
        tenantId: 'other-tenant',
      });
    });

    it('never hand-writes a deleted_at predicate — soft-delete exclusion is TypeORM auto-injection, not a copy that could drift', async () => {
      const qb = mockCurrentSubscriptionOnce({ id: 'sub-1', plan: { max_users: 5 } });
      await service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 1);
      const allCalls = [...qb.where.mock.calls, ...qb.andWhere.mock.calls];
      expect(allCalls.some(([sql]) => /deleted_at/i.test(String(sql)))).toBe(false);
    });

    it('issues exactly one query (createQueryBuilder, not findOne) with limit(1), never take/skip', async () => {
      const qb = mockCurrentSubscriptionOnce({ id: 'sub-1', plan: { max_users: 5 } });
      await service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 1);

      expect(subscriptions.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
      expect(qb.getOne).toHaveBeenCalledTimes(1);
      expect(qb.limit).toHaveBeenCalledWith(1);
      expect(qb.take).not.toHaveBeenCalled();
      expect(qb.skip).not.toHaveBeenCalled();
    });
  });

  describe('getUsage / getBreakdown', () => {
    it('returns zeros when no usage row exists', async () => {
      mockCurrentSubscriptionOnce({ id: 'sub-1' });
      usageRepo.findOne.mockResolvedValueOnce(null);
      const u = await service.getUsage('t1');
      expect(u).toMatchObject({ appointmentsUsed: 0, aiTokensUsed: 0 });
    });

    it('computes remaining and percentUsed per metric', async () => {
      mockCurrentSubscriptionAlways({
        id: 'sub-1',
        plan: {
          id: 'p1',
          name: 'Pro',
          max_appointments: 100,
          max_ai_tokens: null,
          max_whatsapp_messages: 50,
          max_campaigns: 10,
        },
      });
      usageRepo.findOne.mockResolvedValue({
        appointments_used: 25,
        whatsapp_messages_used: 50,
        campaigns_used: 0,
        ai_tokens_used: '0',
      });
      const b = await service.getBreakdown('t1');
      expect(b.metrics.appointments).toMatchObject({
        used: 25,
        limit: 100,
        remaining: 75,
        percentUsed: 25,
        exceeded: false,
      });
      expect(b.metrics.aiTokens.limit).toBeNull();
      expect(b.metrics.whatsappMessages.remaining).toBe(0);
    });

    // Phase 1.4 — a metered metric's true remaining capacity includes any
    // prepaid credit balance, so reporting agrees with what
    // incrementIfWithinLimit would actually admit.
    it('extends the limit by the prepaid CREDIT balance once the plan allowance is exhausted', async () => {
      mockCurrentSubscriptionAlways({
        id: 'sub-1',
        plan: { max_appointments: 100 },
      });
      usageRepo.findOne.mockResolvedValue({ appointments_used: 100 });
      credits.balanceMap.mockResolvedValue(
        new Map([['APPOINTMENTS', { balanceUnits: 30 }]]),
      );

      const b = await service.getBreakdown('t1');

      expect(b.metrics.appointments).toMatchObject({
        used: 100,
        limit: 130, // 100 (plan) + 30 (credit)
        remaining: 30,
        exceeded: false,
        creditBalance: 30,
      });
    });

    it('exposes creditBalance as 0 (not undefined) when the tenant has never bought credit for a metric', async () => {
      mockCurrentSubscriptionAlways({
        id: 'sub-1',
        plan: { max_appointments: 100 },
      });
      usageRepo.findOne.mockResolvedValue({ appointments_used: 10 });
      credits.balanceMap.mockResolvedValue(new Map());

      const b = await service.getBreakdown('t1');

      expect(b.metrics.appointments.creditBalance).toBe(0);
    });
  });

  describe('getUnifiedBreakdown', () => {
    it('extends a metered metric line by the credit balance', async () => {
      mockCurrentSubscriptionAlways({
        id: 'sub-1',
        plan: { max_ai_tokens: '1000' },
      });
      usageRepo.findOne.mockResolvedValue({ ai_tokens_used: '1000' });
      credits.balanceMap.mockResolvedValue(
        new Map([['AI_TOKENS', { balanceUnits: 5000 }]]),
      );

      const out = await service.getUnifiedBreakdown('t1');

      expect(out.aiTokens).toMatchObject({
        used: 1000,
        limit: 6000, // 1000 (plan) + 5000 (credit)
        exceeded: false,
      });
    });

    it('extends a count-based resource line by purchased capacity', async () => {
      mockCurrentSubscriptionAlways({
        id: 'sub-1',
        plan: { max_customers: 50 },
      });
      usageRepo.findOne.mockResolvedValue(null);
      ledger.capacityMap.mockResolvedValue(new Map([['customers', 25]]));

      const out = await service.getUnifiedBreakdown('t1', { customers: 60 });

      expect(out.customers).toMatchObject({
        used: 60,
        limit: 75, // 50 (plan) + 25 (capacity)
        exceeded: false, // 60 <= 75
      });
    });

    it('with no credits/capacity purchased, behaves exactly as before Phase 1.4 (backward compatibility)', async () => {
      mockCurrentSubscriptionAlways({
        id: 'sub-1',
        plan: { max_ai_tokens: '1000', max_customers: 50 },
      });
      usageRepo.findOne.mockResolvedValue({ ai_tokens_used: '400' });

      const out = await service.getUnifiedBreakdown('t1', { customers: 10 });

      expect(out.aiTokens.limit).toBe(1000);
      expect(out.customers.limit).toBe(50);
    });
  });

  // Plan §11 — the unified storage formula. Not yet wired into
  // FileUploadService (deliberately deferred — see the method's docblock);
  // tested standalone here.
  describe('effectiveStorageLimit', () => {
    it('is the plan bytes when it is lower than the platform ceiling', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_storage_bytes: '1000000' }, // 1 MB, well under the 5 GB default ceiling
      });
      const limit = await service.effectiveStorageLimit('t1');
      expect(limit).toBe(1_000_000);
    });

    it('is the platform ceiling when the plan bytes (+ addon) would exceed it', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_storage_bytes: String(100 * 1024 * 1024 * 1024) }, // 100 GB plan
      });
      platformSettings.getTyped.mockResolvedValueOnce(5); // 5 GB ceiling
      const limit = await service.effectiveStorageLimit('t1');
      expect(limit).toBe(5 * 1024 * 1024 * 1024);
    });

    it('adds purchased storageBytes capacity to the plan bytes before comparing to the ceiling', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_storage_bytes: '1000000' },
      });
      ledger.capacityMap.mockResolvedValueOnce(new Map([['storageBytes', 500_000]]));
      const limit = await service.effectiveStorageLimit('t1');
      expect(limit).toBe(1_500_000);
    });

    it('is unlimited-commercial (platform ceiling binds alone) when the plan column is null', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_storage_bytes: null },
      });
      platformSettings.getTyped.mockResolvedValueOnce(5);
      const limit = await service.effectiveStorageLimit('t1');
      expect(limit).toBe(5 * 1024 * 1024 * 1024);
    });

    it('falls back to the platform ceiling alone when the tenant has no subscription', async () => {
      mockCurrentSubscriptionOnce(null);
      platformSettings.getTyped.mockResolvedValueOnce(5);
      const limit = await service.effectiveStorageLimit('t1');
      expect(limit).toBe(5 * 1024 * 1024 * 1024);
    });
  });

  // FND-047: `incrementIfWithinLimit` is called from inside a caller's OPEN
  // `dataSource.transaction()` at 2 real call sites (campaigns, appointments),
  // passing its own `manager`. Every nested read this method makes — the
  // enforcement check, the subscription lookup, the override lookup, and (on
  // the free-mode/unlimited short-circuits) the raw-increment's own
  // subscription lookup — MUST route through that SAME manager. Otherwise each
  // nested read borrows a SECOND pool connection while the transaction already
  // holds a first one; under load (N concurrent transactions == pool size),
  // the pool is fully held by first connections and the second borrow can
  // never be satisfied — a permanent hang, reproduced live in
  // evidence/fnd-047-fix.md (10 concurrent requests, DB_POOL_MAX=10).
  describe('incrementIfWithinLimit — manager threading (FND-047)', () => {
    const metric = USAGE_METRIC.CAMPAIGNS;

    function primeAdmission(overrides: { affected?: number } = {}) {
      const insertQb = createMockQueryBuilder();
      const updateQb = createMockQueryBuilder();
      updateQb.execute.mockResolvedValueOnce({
        affected: overrides.affected ?? 1,
        raw: [],
      });
      usageRepo.createQueryBuilder
        .mockImplementationOnce(() => insertQb)
        .mockImplementationOnce(() => updateQb);
      return { insertQb, updateQb };
    }

    /**
     * Per-entity manager double: `manager.getRepository(Subscription)` and
     * `manager.getRepository(SubscriptionUsage)` return DISTINCT mocks, exactly
     * like the real EntityManager — a test that conflated the two would pass
     * for the wrong reason (both branches happening to default to `affected: 1`).
     */
    function newManager() {
      const managerSubscriptions = createMockRepository();
      (managerSubscriptions as unknown as { metadata: unknown }).metadata = {
        name: 'Subscription',
        findRelationWithPropertyPath: (path: string) =>
          path === 'tenant' ? { joinColumns: [{ databaseName: 'tenantId' }] } : undefined,
      };
      const managerUsage = createMockRepository();
      const manager = createMockEntityManager(
        new Map<unknown, MockRepository>([
          [Subscription, managerSubscriptions],
          [SubscriptionUsage, managerUsage],
        ]),
      );
      return { manager, managerSubscriptions, managerUsage };
    }

    /**
     * T045: primes `repo.createQueryBuilder().getOne()` for exactly the next
     * call — `findCurrentSubscriptionWithPlan`'s mechanism, not `findOne`.
     */
    function mockSubscriptionWithPlanOnce(repo: MockRepository, row: unknown) {
      const qb = createMockQueryBuilder();
      qb.getOne = jest.fn().mockResolvedValue(row);
      repo.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    }

    it('passes the manager through to access.isEnforced', async () => {
      const { manager, managerSubscriptions, managerUsage } = newManager();
      mockSubscriptionWithPlanOnce(managerSubscriptions, {
        id: 'sub-mgr',
        plan: { max_campaigns: 100 },
      });
      managerUsage.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      await service.incrementIfWithinLimit('t1', metric, 1, manager as any);

      expect(access.isEnforced).toHaveBeenCalledWith('t1', manager, [
        'campaigns',
      ]);
    });

    it('resolves the subscription via manager.getRepository(Subscription), never the injected non-transactional repo', async () => {
      const { manager, managerSubscriptions, managerUsage } = newManager();
      mockSubscriptionWithPlanOnce(managerSubscriptions, {
        id: 'sub-mgr',
        plan: { max_campaigns: 100 },
      });
      managerUsage.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      const result = await service.incrementIfWithinLimit(
        't1',
        metric,
        1,
        manager as any,
      );

      expect(managerSubscriptions.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(subscriptions.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({ applied: true, used: 0, limit: 100, fundedBy: 'plan' });
    });

    it('performs the atomic insert+update against manager.getRepository(SubscriptionUsage), never the injected repo', async () => {
      const { manager, managerSubscriptions, managerUsage } = newManager();
      mockSubscriptionWithPlanOnce(managerSubscriptions, {
        id: 'sub-mgr',
        plan: { max_campaigns: 100 },
      });
      managerUsage.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      await service.incrementIfWithinLimit('t1', metric, 1, manager as any);

      expect(managerUsage.createQueryBuilder).toHaveBeenCalledTimes(2); // insert + update
      expect(usageRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('passes the manager through to limitOverrides.getActive', async () => {
      const { manager, managerSubscriptions, managerUsage } = newManager();
      mockSubscriptionWithPlanOnce(managerSubscriptions, {
        id: 'sub-mgr',
        plan: { max_campaigns: 100 },
      });
      managerUsage.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      await service.incrementIfWithinLimit('t1', metric, 1, manager as any);

      expect(limitOverrides.getActive).toHaveBeenCalledWith(
        't1',
        metric,
        manager,
      );
    });

    it('free-mode short-circuit: the raw increment subscription lookup also uses the manager', async () => {
      // isEnforced=false skips requirePlanOrDeny (findCurrentSubscriptionWithPlan)
      // entirely — only rawIncrement's plain findCurrentSubscription (still
      // findOne-based) runs, so this mock is unaffected by T045.
      access.isEnforced.mockResolvedValueOnce(false);
      const { manager, managerSubscriptions, managerUsage } = newManager();
      managerSubscriptions.findOne.mockResolvedValueOnce({ id: 'sub-mgr' });
      managerUsage.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      const result = await service.incrementIfWithinLimit(
        't1',
        metric,
        1,
        manager as any,
      );

      expect(managerSubscriptions.findOne).toHaveBeenCalledTimes(1);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
      expect(result.applied).toBe(true);
    });

    it('unlimited-plan short-circuit: the raw increment subscription lookup also uses the manager', async () => {
      const { manager, managerSubscriptions, managerUsage } = newManager();
      // Two DIFFERENT downstream calls in sequence: requirePlanOrDeny's
      // findCurrentSubscriptionWithPlan (createQueryBuilder, T045) resolves
      // the plan (unlimited), then rawIncrement's findCurrentSubscription
      // (still findOne) resolves the scope for the actual increment.
      mockSubscriptionWithPlanOnce(managerSubscriptions, {
        id: 'sub-mgr',
        plan: { max_campaigns: null },
      });
      managerSubscriptions.findOne.mockResolvedValueOnce({ id: 'sub-mgr' }); // rawIncrement's findCurrentSubscription
      managerUsage.createQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder(),
      );

      const result = await service.incrementIfWithinLimit(
        't1',
        metric,
        1,
        manager as any,
      );

      expect(subscriptions.findOne).not.toHaveBeenCalled();
      expect(subscriptions.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({ applied: true, used: 0, limit: null, fundedBy: 'plan' });
    });

    it('omits the manager for standalone callers (AI/WhatsApp execution — unchanged)', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_campaigns: 100 },
      });
      primeAdmission();

      await service.incrementIfWithinLimit('t1', metric, 1);

      expect(access.isEnforced).toHaveBeenCalledWith('t1', undefined, [
        'campaigns',
      ]);
      expect(limitOverrides.getActive).toHaveBeenCalledWith(
        't1',
        metric,
        undefined,
      );
      // T045: findCurrentSubscriptionWithPlan reads via createQueryBuilder
      // now, not findOne — this still proves the call went through
      // `this.subscriptions` directly (no manager threaded through).
      expect(subscriptions.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('admits when the atomic UPDATE affects a row (one below the limit)', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_campaigns: 100 },
      });
      const { updateQb } = primeAdmission({ affected: 1 });

      const result = await service.incrementIfWithinLimit('t1', metric, 1);

      expect(result).toEqual({ applied: true, used: 0, limit: 100, fundedBy: 'plan' });
      expect(updateQb.where).toHaveBeenCalledWith(
        expect.stringContaining('<= :limit'),
        expect.objectContaining({ amount: 1, limit: 100 }),
      );
    });

    it('refuses (applied: false, fundedBy: none) when the atomic UPDATE affects zero rows and no credit covers it', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_campaigns: 100 },
      });
      primeAdmission({ affected: 0 });
      usageRepo.findOne.mockResolvedValueOnce({ campaigns_used: 100 });
      // credits.tryDebit defaults to false in this suite's beforeEach.

      const result = await service.incrementIfWithinLimit('t1', metric, 1);

      expect(result).toEqual({ applied: false, used: 100, limit: 100, fundedBy: 'none' });
    });

    it('falls back to a prepaid credit when the plan allowance is exhausted (plan §9 spillover)', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_campaigns: 100 },
      });
      const insertQb = createMockQueryBuilder();
      const updateQb = createMockQueryBuilder();
      updateQb.execute.mockResolvedValueOnce({ affected: 0, raw: [] }); // plan UPDATE misses
      const rawIncrementInsertQb = createMockQueryBuilder();
      const rawIncrementUpdateQb = createMockQueryBuilder(); // rawIncrement's own insert+update
      usageRepo.createQueryBuilder
        .mockImplementationOnce(() => insertQb) // incrementIfWithinLimit's upsert
        .mockImplementationOnce(() => updateQb) // incrementIfWithinLimit's guarded UPDATE (misses)
        .mockImplementationOnce(() => rawIncrementInsertQb) // rawIncrement's upsert
        .mockImplementationOnce(() => rawIncrementUpdateQb); // rawIncrement's add
      credits.tryDebit.mockResolvedValueOnce(true);

      const result = await service.incrementIfWithinLimit('t1', metric, 1);

      expect(credits.tryDebit).toHaveBeenCalledWith('t1', metric, 1, undefined);
      expect(result).toEqual({ applied: true, used: 0, limit: 100, fundedBy: 'credit' });
      // rawIncrement's own two query builders (upsert + add) actually ran —
      // proving the credit-funded unit is genuinely recorded, not just
      // reported as applied.
      expect(rawIncrementUpdateQb.execute).toHaveBeenCalled();
    });

    it('a tenant-specific override raises the effective limit used in the atomic UPDATE', async () => {
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_campaigns: 100 },
      });
      limitOverrides.getActive.mockResolvedValueOnce({ override_limit: '150' });
      const { updateQb } = primeAdmission({ affected: 1 });

      const result = await service.incrementIfWithinLimit('t1', metric, 1);

      expect(result.limit).toBe(150);
      expect(updateQb.where).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 150 }),
      );
    });
  });

  /**
   * Admin free access — a tenant granted platform access by a super admin has
   * NO subscription by design, so metering must not demand one.
   *
   * Regression origin: `POST /whatsapp/templates/:id/send` failed with
   * "No active subscription found for this tenant" thrown from
   * `resolveSubscription()`, because enforcement was decided without regard to
   * how access had been granted.
   */
  describe('incrementIfWithinLimit — free-access tenants (no subscription)', () => {
    it('does NOT throw "No active subscription found" when enforcement is off and no subscription exists', async () => {
      access.isEnforced.mockResolvedValueOnce(false);
      mockCurrentSubscriptionAlways(null); // free-access tenant: no subscription

      const result = await service.incrementIfWithinLimit(
        't1',
        USAGE_METRIC.WHATSAPP_MESSAGES,
        1,
      );

      expect(result).toEqual({ applied: true, used: 0, limit: null, fundedBy: 'plan' });
    });

    /**
     * Still fails closed — the usage layer remains the gate for worker and bot
     * paths that never pass through a guard — but the REFUSAL now comes from
     * the centralized policy, not from a subscription lookup.
     *
     * This test previously asserted `NOT_FOUND`, i.e. the literal
     * `404 No active subscription found for this tenant` this work exists to
     * remove. That response reached unauthenticated visitors on public booking
     * and guest chat, describing the clinic's billing internals to answer what
     * is simply an access denial.
     */
    it('refuses through the centralized policy, never with a bare NOT_FOUND', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      mockCurrentSubscriptionOnce(null);
      access.assertAccess.mockRejectedValueOnce(denied());

      await expect(
        service.incrementIfWithinLimit('t1', USAGE_METRIC.WHATSAPP_MESSAGES, 1),
      ).rejects.toMatchObject({ code: ErrorCode.NO_ACTIVE_SUBSCRIPTION });

      expect(access.assertAccess).toHaveBeenCalledWith(
        't1',
        'whatsapp',
        expect.objectContaining({ surface: 'service' }),
      );
    });

    /**
     * The narrow window where enforcement is reported ON but access is
     * genuinely allowed and there is still no plan: shadow mode, or a grant
     * that landed between the two reads. Recording the usage and admitting is
     * correct — inventing a cap out of a missing subscription is not.
     */
    it('records and admits when access is allowed but no plan exists', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      mockCurrentSubscriptionAlways(null);
      access.assertAccess.mockResolvedValueOnce({ allowed: false });

      await expect(
        service.incrementIfWithinLimit('t1', USAGE_METRIC.WHATSAPP_MESSAGES, 1),
      ).resolves.toEqual({ applied: true, used: 0, limit: null, fundedBy: 'plan' });
    });

    it('asks about the feature the metric belongs to — scoped, never a blanket bypass', async () => {
      access.isEnforced.mockResolvedValueOnce(false);
      mockCurrentSubscriptionAlways(null);

      await service.incrementIfWithinLimit(
        't1',
        USAGE_METRIC.WHATSAPP_MESSAGES,
        1,
      );
      expect(access.isEnforced).toHaveBeenCalledWith('t1', undefined, [
        'whatsapp',
      ]);

      access.isEnforced.mockResolvedValueOnce(false);
      await service.incrementIfWithinLimit('t1', USAGE_METRIC.APPOINTMENTS, 1);
      expect(access.isEnforced).toHaveBeenCalledWith('t1', undefined, [
        'appointments',
      ]);
    });

    // The `ai` half of the old `['ai', 'ai.assistant']` alias is gone: the
    // feature list is now DERIVED from each registry spec's `usageMetric`, so
    // there is no second hand-maintained list to keep in step, and `ai` is no
    // longer a key any route or catalog row uses.
    it('routes every metered metric through its own feature keys', async () => {
      for (const [metric, keys] of [
        [USAGE_METRIC.AI_TOKENS, ['ai.assistant']],
        [USAGE_METRIC.WHATSAPP_MESSAGES, ['whatsapp']],
        [USAGE_METRIC.APPOINTMENTS, ['appointments']],
        [USAGE_METRIC.CAMPAIGNS, ['campaigns']],
      ] as const) {
        access.isEnforced.mockResolvedValueOnce(false);
        mockCurrentSubscriptionAlways(null);
        await service.incrementIfWithinLimit('t1', metric, 1);
        expect(access.isEnforced).toHaveBeenCalledWith('t1', undefined, keys);
      }
    });
  });

  /**
   * Count-based caps (`max_branches`, `max_users`) and the read-only breakdowns
   * used to ask the UNSCOPED enforcement question and then hard-require a
   * subscription. For a clinic running on a super-admin grant that produced a
   * bare `404 No active subscription found for this tenant` from branch
   * creation, staff invites, `GET /usage/breakdown`, the AI usage tool and the
   * billing-upgrade estimate — the same class of split the metered paths were
   * fixed for in 2026-08, left unfixed on these.
   */
  describe('count caps and breakdowns for tenants with no plan', () => {
    it('asks the capability-scoped question for a branch cap', async () => {
      access.isEnforced.mockResolvedValueOnce(false);
      await service.assertCountWithinLimit('t1', COUNT_LIMIT.BRANCHES, 5);
      expect(access.isEnforced).toHaveBeenCalledWith('t1', undefined, [
        'branches',
      ]);
    });

    it('asks the capability-scoped question for a seat cap', async () => {
      const manager = createMockEntityManager();
      access.isEnforced.mockResolvedValueOnce(false);
      await service.assertUserSeatWithinLimit('t1', manager as never);
      expect(access.isEnforced).toHaveBeenCalledWith('t1', manager, ['staff']);
    });

    it('does not refuse a branch when there is no plan to cap against', async () => {
      access.isEnforced.mockResolvedValue(true); // denied tenants stay enforced
      mockCurrentSubscriptionAlways(null);
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.BRANCHES, 5),
      ).resolves.toBeUndefined();
    });

    it('does not refuse a seat when there is no plan to cap against', async () => {
      const manager = createMockEntityManager();
      access.isEnforced.mockResolvedValue(true);
      await expect(
        service.assertUserSeatWithinLimit('t1', manager as never),
      ).resolves.toBeUndefined();
    });

    // Phase 1.4 (closes G2) — same fix as the other two count-based asserts.
    it('honors purchased CAPACITY on top of the seat cap', async () => {
      const managerSubscriptions = createMockRepository();
      const managerUsers = createMockRepository();
      // NOT part of T045 — assertUserSeatWithinLimit has its own inline
      // `findOne` (a separate, duplicated instance of the same query shape,
      // not a call to findCurrentSubscriptionWithPlan), so this mock is
      // unaffected and stays as-is.
      managerSubscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        plan: { max_users: 5 },
      });
      managerUsers.count.mockResolvedValueOnce(6); // 6 existing seats
      const manager = createMockEntityManager(
        new Map<unknown, MockRepository>([
          [Subscription, managerSubscriptions],
          [User, managerUsers],
        ]),
      );
      access.isEnforced.mockResolvedValueOnce(true);
      ledger.capacityMap.mockResolvedValueOnce(new Map([['employees', 2]]));

      // effective = 5 (plan) + 2 (capacity) = 7; 6 existing + 1 fits.
      await expect(
        service.assertUserSeatWithinLimit('t1', manager as never),
      ).resolves.toBeUndefined();
      expect(ledger.capacityMap).toHaveBeenCalledWith('t1', manager);
      expect(limitOverrides.getActive).toHaveBeenCalledWith(
        't1',
        'employees',
        manager,
      );
    });

    it('reports an all-unlimited breakdown instead of throwing NOT_FOUND', async () => {
      mockCurrentSubscriptionAlways(null);
      usageRepo.findOne.mockResolvedValue({
        ai_tokens_used: '12',
        whatsapp_messages_used: 3,
        appointments_used: 0,
        campaigns_used: 0,
      });

      const breakdown = await service.getBreakdown('t1');

      expect(breakdown.planId).toBeNull();
      expect(breakdown.metrics.whatsappMessages).toMatchObject({
        used: 3,
        limit: null,
        exceeded: false,
      });
      // The recorded consumption is reported, not hidden behind a 404.
      expect(breakdown.metrics.aiTokens.used).toBe(12);
    });
  });

  // ──────────────── Count-based resource caps (plan §9 closure) ──────────── //

  describe('assertResourceWithinLimit', () => {
    it('enforces the plan column when the tenant is metered', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_customers: 100 },
      });

      await expect(
        service.assertResourceWithinLimit('t1', 'customers', 100),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('admits below the cap', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_customers: 100 },
      });

      await expect(
        service.assertResourceWithinLimit('t1', 'customers', 42),
      ).resolves.toBeUndefined();
    });

    /**
     * The whole point of scoping: a tenant on a super-admin CRM grant has no
     * plan and no cap, and must not be refused — nor asked for a subscription
     * that by design does not exist.
     */
    it('asks about the CAPABILITY the resource belongs to, not a blanket question', async () => {
      access.isEnforced.mockResolvedValueOnce(false);
      await service.assertResourceWithinLimit('t1', 'customers', 999_999);
      expect(access.isEnforced).toHaveBeenCalledWith('t1', undefined, ['crm']);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
    });

    it('treats a null plan column as unlimited', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_knowledge_base_files: null },
      });

      await expect(
        service.assertResourceWithinLimit('t1', 'knowledgeBaseFiles', 10_000),
      ).resolves.toBeUndefined();
    });

    // Phase 1.4 (closes G2) — same fix as assertCountWithinLimit, generalized
    // to every ENFORCED_RESOURCE_LIMITS metric.
    it('honors purchased CAPACITY on top of the plan limit', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_customers: 100 },
      });
      ledger.capacityMap.mockResolvedValueOnce(new Map([['customers', 20]]));
      // effective = 100 + 20 = 120; at 119 existing, +1 fits.
      await expect(
        service.assertResourceWithinLimit('t1', 'customers', 119),
      ).resolves.toBeUndefined();
    });

    it('honors an active OVERRIDE on top of the plan limit', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_customers: 100 },
      });
      limitOverrides.getActive.mockResolvedValueOnce({ override_limit: '200' });
      await expect(
        service.assertResourceWithinLimit('t1', 'customers', 199),
      ).resolves.toBeUndefined();
    });

    it('still refuses once override + capacity are exhausted too', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      mockCurrentSubscriptionOnce({
        id: 'sub-1',
        plan: { max_customers: 100 },
      });
      limitOverrides.getActive.mockResolvedValueOnce({ override_limit: '110' });
      ledger.capacityMap.mockResolvedValueOnce(new Map([['customers', 5]]));
      // effective = max(100, 110) + 5 = 115; at 115 existing, +1 exceeds it.
      await expect(
        service.assertResourceWithinLimit('t1', 'customers', 115),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    /**
     * A plan column existing is not a reason to refuse a write. Refusing to
     * record a payment that already cleared, or dropping an inbound customer
     * conversation, is worse than exceeding a soft cap — so those metrics are
     * reporting-only, and enforcing one is a coding error that must surface in
     * tests rather than in production.
     */
    it.each([
      'payments',
      'transactions',
      'invoices',
      'emails',
      'apiCalls',
      'conversations',
      'crmContacts',
      'aiRequests',
    ] as const)(
      'refuses to enforce the reporting-only metric "%s"',
      async (metric) => {
        await expect(
          service.assertResourceWithinLimit('t1', metric, 1),
        ).rejects.toThrow(/reporting-only/);
      },
    );
  });

  describe('FIN-011 — credit-funded reservations', () => {
    it('settleCreditRemainder debits the remainder from the credit balance', async () => {
      await service.settleCreditRemainder('t1', USAGE_METRIC.AI_TOKENS, 499);
      expect(credits.settle).toHaveBeenCalledWith('t1', USAGE_METRIC.AI_TOKENS, 499);
    });

    it('settleCreditRemainder is a no-op for a non-positive remainder', async () => {
      await service.settleCreditRemainder('t1', USAGE_METRIC.AI_TOKENS, 0);
      expect(credits.settle).not.toHaveBeenCalled();
    });

    it('release gives a CREDIT-funded reservation back to the credit balance', async () => {
      await service.release('t1', USAGE_METRIC.AI_TOKENS, 1, 'credit');
      expect(credits.refundReservation).toHaveBeenCalledWith('t1', USAGE_METRIC.AI_TOKENS, 1);
    });

    it('release of a plan-funded reservation never touches credits', async () => {
      await service.release('t1', USAGE_METRIC.AI_TOKENS, 1);
      expect(credits.refundReservation).not.toHaveBeenCalled();
    });
  });
});
