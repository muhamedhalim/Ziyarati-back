import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { AccessControlService } from './access-control.service';
import { AccessCacheService } from './access-cache.service';
import { AccessPolicyModeService } from './access-policy-mode.service';
import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { FeatureFlagService, FlagState } from './feature-flag.service';
import { UsageService } from './usage.service';
import { TenantUsageLimitOverrideService } from './tenant-usage-limit-override.service';
import { TenantEntitlementLedgerService } from './tenant-entitlement-ledger.service';
import { TenantMetricCreditsService } from './tenant-metric-credits.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { FeatureGuard } from './guards/feature.guard';
import { FeatureKey } from './feature-registry';
import { COUNT_LIMIT } from './usage-metric';
import { FeatureFlagSource } from '../../entities/SaaS-Core/FeatureFlag';
import { SubscriptionStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockAccessCache,
  createMockAccessPolicyMode,
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

/**
 * The reported failure, end to end.
 *
 * A Super Admin enabled a clinic through `/platform/feature-flags` and branch
 * creation still answered "your clinic account has been approved, but you do
 * not have an active subscription yet". The chain here is the real one —
 * `FeatureGuard` → `AccessControlService` → `UsageService` — with only the
 * repositories doubled, because the bug was never in any single unit: each
 * piece behaved correctly in isolation and the console simply never wrote the
 * grant they all read.
 *
 * These cases pin the four business states the platform sells:
 *   approved + no subscription + no grant  → blocked
 *   approved + no subscription + grant     → allowed, unmetered
 *   active subscription + plan includes it → allowed, plan quotas enforced
 *   suspended                              → denied, even while paying
 */
describe('Super-admin feature override — branch creation', () => {
  let access: AccessControlService;
  let usage: UsageService;
  let guard: FeatureGuard;

  let subscriptions: MockRepository;
  let definitions: MockRepository;
  let featurePlans: MockRepository;
  let subscriptionUsage: MockRepository;
  let billingMode: { isPaidMode: jest.Mock };
  let overrides: { getActive: jest.Mock; hasActive: jest.Mock };
  let featureFlags: { getStates: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };

  const future = new Date(Date.now() + 86_400_000);
  const TENANT = 't1';

  /** An authoritative (super-admin) grant, exactly as the console writes it. */
  const grant = (...keys: FeatureKey[]): Map<string, FlagState> =>
    new Map(
      keys.map((k) => [
        k,
        {
          granted: true,
          suspended: false,
          source: FeatureFlagSource.PLATFORM_ADMIN,
        },
      ]),
    );

  const suspend = (key: FeatureKey): Map<string, FlagState> =>
    new Map([
      [
        key,
        {
          granted: false,
          suspended: true,
          source: FeatureFlagSource.PLATFORM_ADMIN,
        },
      ],
    ]);

  /** A usable paid subscription on `plan-1`, with the given branch cap. */
  const paidPlan = (maxBranches: number | null = 5) => ({
    id: 'sub-1',
    status: SubscriptionStatus.ACTIVE,
    ends_at: future,
    plan: { id: 'plan-1', max_branches: maxBranches },
  });

  /** The guard as `POST /branches` invokes it: `@RequireFeature(BRANCHES)`. */
  const branchRequest = () => {
    const request = {
      user: { tenantId: TENANT },
      method: 'POST',
      path: '/branches',
    };
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    subscriptions = createMockRepository();
    // T045 (015-db-api-efficiency-audit, P7-2/ORM-001): UsageService's
    // findCurrentSubscriptionWithPlan now reads via createQueryBuilder, not
    // findOne — the tenant FK column comes from entity metadata (R-11)
    // instead of `findOne({ relations })`.
    (subscriptions as unknown as { metadata: unknown }).metadata = {
      name: 'Subscription',
      findRelationWithPropertyPath: (path: string) =>
        path === 'tenant' ? { joinColumns: [{ databaseName: 'tenantId' }] } : undefined,
    };
    definitions = createMockRepository();
    featurePlans = createMockRepository();
    subscriptionUsage = createMockRepository();
    billingMode = { isPaidMode: jest.fn().mockResolvedValue(true) };
    overrides = {
      getActive: jest.fn().mockResolvedValue(null),
      hasActive: jest.fn().mockResolvedValue(false),
    };
    featureFlags = { getStates: jest.fn().mockResolvedValue(new Map()) };
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(FeatureKey.BRANCHES),
    };

    // Catalog empty = registry defaults apply, and no `feature_plans` rows =
    // "available on every plan" — the production state for a fresh platform.
    definitions.find.mockResolvedValue([]);
    featurePlans.find.mockResolvedValue([]);
    mockSubscription(null);

    access = new AccessControlService(
      subscriptions as never,
      definitions as never,
      featurePlans as never,
      billingMode as unknown as BillingModeService,
      overrides as unknown as FreeAccessOverrideService,
      featureFlags as unknown as FeatureFlagService,
      { get: jest.fn().mockReturnValue(14) } as unknown as ConfigService,
      createMockAccessCache() as unknown as AccessCacheService,
      createMockAccessPolicyMode() as unknown as AccessPolicyModeService,
    );

    usage = new UsageService(
      subscriptions as never,
      subscriptionUsage as never,
      access,
      {
        getActive: jest.fn().mockResolvedValue(null),
      } as unknown as TenantUsageLimitOverrideService,
      {
        capacityMap: jest.fn().mockResolvedValue(new Map()),
      } as unknown as TenantEntitlementLedgerService,
      {
        balanceMap: jest.fn().mockResolvedValue(new Map()),
      } as unknown as TenantMetricCreditsService,
      {
        getTyped: jest.fn().mockResolvedValue(5),
      } as unknown as SystemSettingService,
    );

    guard = new FeatureGuard(reflector as unknown as Reflector, access);
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * T045 (015-db-api-efficiency-audit, P7-2): `UsageService
   * .findCurrentSubscriptionWithPlan` reads via `createQueryBuilder()
   * .getOne()`, not `findOne()` — but `AccessControlService` (also
   * constructed against this same `subscriptions` mock) may have its own
   * subscription lookups unaffected by that change. Primes BOTH mechanisms
   * so every pre-existing `subscriptions.findOne.mockResolvedValue(...)`
   * call site keeps working regardless of which one actually gets invoked.
   */
  function mockSubscription(row: unknown) {
    subscriptions.findOne.mockResolvedValue(row as never);
    const qb = createMockQueryBuilder();
    qb.getOne = jest.fn().mockResolvedValue(row);
    subscriptions.createQueryBuilder.mockReturnValue(qb);
  }

  // ────────────────────────── The four business states ───────────────────── //

  it('blocks an approved clinic with no subscription and no grant', async () => {
    await expect(guard.canActivate(branchRequest())).rejects.toMatchObject({
      code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
    });
  });

  it('admits a clinic with NO subscription once branches is granted', async () => {
    featureFlags.getStates.mockResolvedValue(grant(FeatureKey.BRANCHES));

    await expect(guard.canActivate(branchRequest())).resolves.toBe(true);

    const decision = await access.resolve(TENANT, FeatureKey.BRANCHES);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('feature_override');
    expect(decision.grantedVia).toEqual({ directly: true });
  });

  it('admits a paying clinic whose plan includes branches', async () => {
    mockSubscription(paidPlan());
    await expect(guard.canActivate(branchRequest())).resolves.toBe(true);
  });

  it('denies a suspended capability even with a paid subscription', async () => {
    mockSubscription(paidPlan());
    featureFlags.getStates.mockResolvedValue(suspend(FeatureKey.BRANCHES));

    // The tenant still holds platform access, so the remedy is not "buy a
    // plan" — the guard must say the CAPABILITY is unavailable, not the
    // subscription.
    await expect(guard.canActivate(branchRequest())).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('denies a suspended capability that also carries a grant', async () => {
    // Suspension outranks the override: `applyState` deliberately leaves an
    // existing grant in place when suspending, so both rows coexist and the
    // block must still win.
    featureFlags.getStates.mockResolvedValue(
      new Map([
        [
          FeatureKey.BRANCHES,
          {
            granted: true,
            suspended: true,
            source: FeatureFlagSource.PLATFORM_ADMIN,
          },
        ],
      ]),
    );
    const decision = await access.resolve(TENANT, FeatureKey.BRANCHES);
    expect(decision.allowed).toBe(false);
  });

  // ────────────────────────────── Grant scope ────────────────────────────── //

  it('grants ONLY branches — not whatsapp, campaigns or the AI assistant', async () => {
    featureFlags.getStates.mockResolvedValue(grant(FeatureKey.BRANCHES));

    const decisions = await access.resolveAll(TENANT);
    expect(decisions.get(FeatureKey.BRANCHES)?.allowed).toBe(true);
    for (const other of [
      FeatureKey.WHATSAPP,
      FeatureKey.CAMPAIGNS,
      FeatureKey.AI_ASSISTANT,
      FeatureKey.APPOINTMENTS,
    ]) {
      expect(decisions.get(other)?.allowed).toBe(false);
    }
  });

  it('grants a capability together with its declared dependency closure', async () => {
    // Enabling WhatsApp for a clinic with no plan has to produce a WORKING
    // inbox, and that inbox reads conversations and customer records.
    featureFlags.getStates.mockResolvedValue(grant(FeatureKey.WHATSAPP));

    const decisions = await access.resolveAll(TENANT);
    expect(decisions.get(FeatureKey.WHATSAPP)?.allowed).toBe(true);
    expect(decisions.get(FeatureKey.CONVERSATIONS)?.allowed).toBe(true);
    expect(decisions.get(FeatureKey.CRM)?.allowed).toBe(true);
    // …and nothing outside it.
    expect(decisions.get(FeatureKey.BRANCHES)?.allowed).toBe(false);
    expect(decisions.get(FeatureKey.CAMPAIGNS)?.allowed).toBe(false);

    expect(decisions.get(FeatureKey.CRM)?.grantedVia).toEqual({
      directly: false,
      viaDependencyOf: FeatureKey.WHATSAPP,
    });
  });

  it('never gates an always-on capability, even for a fully denied clinic', async () => {
    // A denied clinic that cannot reach billing or support has no way back.
    const decisions = await access.resolveAll(TENANT);
    for (const key of [
      FeatureKey.BILLING,
      FeatureKey.SUPPORT,
      FeatureKey.CORE_WORKSPACE,
    ]) {
      expect(decisions.get(key)?.allowed).toBe(true);
    }
  });

  // ─────────────────────────── Quotas vs. grants ─────────────────────────── //

  it('still enforces the plan branch cap for a PAYING clinic', async () => {
    mockSubscription(paidPlan(2));

    await expect(
      usage.assertCountWithinLimit(TENANT, COUNT_LIMIT.BRANCHES, 2),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

    // …and admits it below the cap.
    await expect(
      usage.assertCountWithinLimit(TENANT, COUNT_LIMIT.BRANCHES, 1),
    ).resolves.toBeUndefined();
  });

  it('leaves a granted clinic with NO subscription unmetered by plan', async () => {
    featureFlags.getStates.mockResolvedValue(grant(FeatureKey.BRANCHES));

    expect(
      await access.isEnforced(TENANT, undefined, [FeatureKey.BRANCHES]),
    ).toBe(false);
    // There is no plan to meter against, so the cap cannot apply at any count.
    await expect(
      usage.assertCountWithinLimit(TENANT, COUNT_LIMIT.BRANCHES, 99),
    ).resolves.toBeUndefined();
  });

  it('a grant is NOT a quota bypass for a clinic that is already paying', async () => {
    // Precedence: a usable subscription (rule 4) is consulted before the
    // per-feature grant (rule 5), so a paying clinic resolves through its plan
    // and keeps its cap. The override substitutes for a MISSING subscription;
    // layering it on an existing one must not silently buy unlimited branches.
    featureFlags.getStates.mockResolvedValue(grant(FeatureKey.BRANCHES));
    mockSubscription(paidPlan(2));

    const decision = await access.resolve(TENANT, FeatureKey.BRANCHES);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('subscription');
    expect(
      await access.isEnforced(TENANT, undefined, [FeatureKey.BRANCHES]),
    ).toBe(true);
    await expect(
      usage.assertCountWithinLimit(TENANT, COUNT_LIMIT.BRANCHES, 2),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
  });

  it('does not unmeter a capability the grant did not cover', async () => {
    // A branches grant must not hand the clinic an unlimited customer count.
    featureFlags.getStates.mockResolvedValue(grant(FeatureKey.BRANCHES));
    mockSubscription(paidPlan(2));

    expect(await access.isEnforced(TENANT, undefined, [FeatureKey.CRM])).toBe(
      true,
    );
  });

  it('reports a DENIED clinic as enforced, so unguarded paths fail closed', async () => {
    // Worker and bot paths never pass a guard; answering "not enforced" for a
    // refused tenant would hand them an unlimited allowance.
    expect(await access.isEnforced(TENANT, undefined, [FeatureKey.BRANCHES]))
      .toBe(true);
  });

  // ───────────────────── The exact shape of the old bug ──────────────────── //

  it('a default-on capability is NOT granted merely by being default-on', async () => {
    // `branches` has `defaultEnabled: true`. That is what the console rendered
    // as an ON switch — while `feature_flags` held no row and the policy, quite
    // correctly, refused. The default must never stand in for a grant.
    definitions.find.mockResolvedValue([
      { feature_key: FeatureKey.BRANCHES, default_enabled: true },
    ]);

    const decision = await access.resolve(TENANT, FeatureKey.BRANCHES);
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('none');
  });

  it('ignores a tenant-written flag row — a clinic cannot self-grant', async () => {
    featureFlags.getStates.mockResolvedValue(
      new Map([
        [
          FeatureKey.BRANCHES,
          {
            granted: false, // FeatureFlagService already refuses the provenance
            suspended: false,
            source: FeatureFlagSource.TENANT,
          },
        ],
      ]),
    );
    await expect(guard.canActivate(branchRequest())).rejects.toMatchObject({
      code: ErrorCode.NO_ACTIVE_SUBSCRIPTION,
    });
  });
});
