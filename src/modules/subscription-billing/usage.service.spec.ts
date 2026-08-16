import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UsageService } from './usage.service';
import { AccessControlService } from './access-control.service';
import { TenantUsageLimitOverrideService } from './tenant-usage-limit-override.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
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

  /** The platform's standard access-denied error, as `assertAccess` raises it. */
  const denied = () =>
    Object.assign(new Error('no access'), {
      code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
    });

  beforeEach(async () => {
    subscriptions = createMockRepository();
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

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: getRepositoryToken(SubscriptionUsage), useValue: usageRepo },
        { provide: AccessControlService, useValue: access },
        { provide: TenantUsageLimitOverrideService, useValue: limitOverrides },
      ],
    }).compile();
    service = moduleRef.get(UsageService);
  });

  afterEach(() => jest.clearAllMocks());

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
      subscriptions.findOne.mockResolvedValueOnce(null);
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 1);
      // insert(orIgnore) + update => two query builders
      expect(usageRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('still records usage when the tenant has no subscription', async () => {
      // Previously this returned early, so a clinic running on a super-admin
      // feature grant produced no usage rows at all and the platform was blind
      // to what it consumed. There is no plan to CAP it against, but that is a
      // reason not to enforce — not a reason not to count.
      subscriptions.findOne.mockResolvedValueOnce(null);
      await service.increment('t1', USAGE_METRIC.APPOINTMENTS, 1);
      // insert(orIgnore) + update => two query builders
      expect(usageRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('upserts then atomically increments the metric', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1' });
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
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        plan: { max_appointments: null },
      });
      await expect(
        service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS),
      ).resolves.toBeUndefined();
    });

    it('allows when usage stays within the plan limit', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        plan: { max_appointments: 100 },
      });
      usageRepo.findOne.mockResolvedValueOnce({ appointments_used: 50 });
      await expect(
        service.assertWithinLimit('t1', USAGE_METRIC.APPOINTMENTS, 10),
      ).resolves.toBeUndefined();
    });

    it('throws 422 when the increment would exceed the limit', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
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
      subscriptions.findOne.mockResolvedValueOnce({
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
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        plan: { max_users: null },
      });
      await expect(
        service.assertCountWithinLimit('t1', COUNT_LIMIT.USERS, 999),
      ).resolves.toBeUndefined();
    });
  });

  describe('getUsage / getBreakdown', () => {
    it('returns zeros when no usage row exists', async () => {
      subscriptions.findOne.mockResolvedValueOnce({ id: 'sub-1' });
      usageRepo.findOne.mockResolvedValueOnce(null);
      const u = await service.getUsage('t1');
      expect(u).toMatchObject({ appointmentsUsed: 0, aiTokensUsed: 0 });
    });

    it('computes remaining and percentUsed per metric', async () => {
      subscriptions.findOne.mockResolvedValue({
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
      const managerUsage = createMockRepository();
      const manager = createMockEntityManager(
        new Map<unknown, MockRepository>([
          [Subscription, managerSubscriptions],
          [SubscriptionUsage, managerUsage],
        ]),
      );
      return { manager, managerSubscriptions, managerUsage };
    }

    it('passes the manager through to access.isEnforced', async () => {
      const { manager, managerSubscriptions, managerUsage } = newManager();
      managerSubscriptions.findOne.mockResolvedValueOnce({
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
      managerSubscriptions.findOne.mockResolvedValueOnce({
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

      expect(managerSubscriptions.findOne).toHaveBeenCalledTimes(1);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
      expect(result).toEqual({ applied: true, used: 0, limit: 100 });
    });

    it('performs the atomic insert+update against manager.getRepository(SubscriptionUsage), never the injected repo', async () => {
      const { manager, managerSubscriptions, managerUsage } = newManager();
      managerSubscriptions.findOne.mockResolvedValueOnce({
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
      managerSubscriptions.findOne.mockResolvedValueOnce({
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
      managerSubscriptions.findOne
        .mockResolvedValueOnce({ id: 'sub-mgr', plan: { max_campaigns: null } }) // resolveSubscription
        .mockResolvedValueOnce({ id: 'sub-mgr' }); // rawIncrement's findCurrentSubscription
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
      expect(result).toEqual({ applied: true, used: 0, limit: null });
    });

    it('omits the manager for standalone callers (AI/WhatsApp execution — unchanged)', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
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
      expect(subscriptions.findOne).toHaveBeenCalledTimes(1);
    });

    it('admits when the atomic UPDATE affects a row (one below the limit)', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        plan: { max_campaigns: 100 },
      });
      const { updateQb } = primeAdmission({ affected: 1 });

      const result = await service.incrementIfWithinLimit('t1', metric, 1);

      expect(result).toEqual({ applied: true, used: 0, limit: 100 });
      expect(updateQb.where).toHaveBeenCalledWith(
        expect.stringContaining('<= :limit'),
        expect.objectContaining({ amount: 1, limit: 100 }),
      );
    });

    it('refuses (applied: false) when the atomic UPDATE affects zero rows (already exhausted)', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        plan: { max_campaigns: 100 },
      });
      primeAdmission({ affected: 0 });
      usageRepo.findOne.mockResolvedValueOnce({ campaigns_used: 100 });

      const result = await service.incrementIfWithinLimit('t1', metric, 1);

      expect(result).toEqual({ applied: false, used: 100, limit: 100 });
    });

    it('a tenant-specific override raises the effective limit used in the atomic UPDATE', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
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
      subscriptions.findOne.mockResolvedValue(null); // free-access tenant: no subscription

      const result = await service.incrementIfWithinLimit(
        't1',
        USAGE_METRIC.WHATSAPP_MESSAGES,
        1,
      );

      expect(result).toEqual({ applied: true, used: 0, limit: null });
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
      subscriptions.findOne.mockResolvedValueOnce(null);
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
      subscriptions.findOne.mockResolvedValue(null);
      access.assertAccess.mockResolvedValueOnce({ allowed: false });

      await expect(
        service.incrementIfWithinLimit('t1', USAGE_METRIC.WHATSAPP_MESSAGES, 1),
      ).resolves.toEqual({ applied: true, used: 0, limit: null });
    });

    it('asks about the feature the metric belongs to — scoped, never a blanket bypass', async () => {
      access.isEnforced.mockResolvedValueOnce(false);
      subscriptions.findOne.mockResolvedValue(null);

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
        subscriptions.findOne.mockResolvedValue(null);
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
      subscriptions.findOne.mockResolvedValue(null);
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

    it('reports an all-unlimited breakdown instead of throwing NOT_FOUND', async () => {
      subscriptions.findOne.mockResolvedValue(null);
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
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        plan: { max_customers: 100 },
      });

      await expect(
        service.assertResourceWithinLimit('t1', 'customers', 100),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('admits below the cap', async () => {
      access.isEnforced.mockResolvedValueOnce(true);
      subscriptions.findOne.mockResolvedValueOnce({
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
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub-1',
        plan: { max_knowledge_base_files: null },
      });

      await expect(
        service.assertResourceWithinLimit('t1', 'knowledgeBaseFiles', 10_000),
      ).resolves.toBeUndefined();
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
});
