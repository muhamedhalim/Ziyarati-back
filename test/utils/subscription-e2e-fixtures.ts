/**
 * Shared Wave 3 e2e fixtures: a tenant with a REAL active subscription under
 * a caller-controlled plan limit, plus the global billing-mode switch.
 *
 * `BillingModeService` defaults to FREE when `system_settings` has no
 * `billing.mode` row (the safe rollout default — see
 * `platform-billing.constants.ts`), and this dev DB has no such row. Under
 * FREE mode `AccessControlService.isEnforced()` is unconditionally false, so
 * every quota/seat-cap/subscription check in this feature is a no-op. Any
 * test that wants to exercise those checks MUST call `setPaidMode` first.
 */
import { E2eApp } from './whatsapp-e2e-app';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { SubscriptionPlan } from '../../src/entities/SaaS-Core/SubscriptionPlan';
import { Subscription } from '../../src/entities/SaaS-Core/Subscription';
import { FeatureFlag } from '../../src/entities/SaaS-Core/FeatureFlag';
import { BillingCycle, SubscriptionStatus } from '../../src/entities/enums';
import { BillingModeService } from '../../src/modules/subscription-billing/billing-mode.service';
import { BillingMode } from '../../src/modules/subscription-billing/platform-billing.constants';
import { User } from '../../src/entities/Auth&RBAC/User';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { TenantApprovalStatus } from '../../src/entities/enums';
import { randomUUID } from 'node:crypto';

/**
 * Flips the GLOBAL platform billing mode to PAID via the real service
 * (audited, cached).
 *
 * This setting is a single row in `system_settings` — process-wide, not
 * scoped to any one test's tenant. Under `--runInBand`, every e2e spec file
 * in `test/` shares ONE Node process and ONE database across the whole run,
 * so a flip left unset here silently persists past this file's own tests and
 * breaks any LATER-running suite that (correctly, for a subscription-less
 * fixture tenant) expects the FREE-mode default — e.g. a pre-existing Wave 1
 * suite using `createOwnerFixture` (no subscription) unexpectedly getting a
 * 403 from `AccessControlService.assertUsable()`.
 *
 * Every caller MUST pair this with `resetBillingMode(e2e)` in its OWN
 * top-level `afterAll` (NOT inside `setPaidMode` itself — Jest forbids
 * registering a hook from inside another hook, and every current caller
 * invokes this from inside `beforeAll`).
 */
export async function setPaidMode(e2e: E2eApp): Promise<void> {
  const billingMode = e2e.moduleRef.get(BillingModeService, { strict: false });
  await billingMode.set(BillingMode.PAID);
}

/** Pairs with `setPaidMode` — flips the global billing mode back to FREE. Call from the suite's own top-level `afterAll`, alongside `e2e.app.close()`. */
export async function resetBillingMode(e2e: E2eApp): Promise<void> {
  const billingMode = e2e.moduleRef.get(BillingModeService, { strict: false });
  await billingMode.set(BillingMode.FREE);
}

export interface SubscribedOwnerFixture {
  tenantId: string;
  userId: string;
  token: string;
  email: string;
  planId: string;
  subscriptionId: string;
}

/** Every plan cap this feature reads, all nullable=unlimited unless overridden. */
export type PlanLimits = Partial<{
  max_branches: number;
  max_users: number;
  max_ai_tokens: string;
  max_whatsapp_messages: number;
  max_appointments: number;
  max_campaigns: number;
}>;

/**
 * Creates an APPROVED tenant + owner user (same shape as `createOwnerFixture`)
 * PLUS a real `SubscriptionPlan` (only the given limits set, everything else
 * unlimited) and an ACTIVE `Subscription` tying them together. Does NOT flip
 * billing mode — call `setPaidMode` separately (most suites need it once per
 * `beforeAll`, not once per fixture).
 */
export async function createSubscribedOwnerFixture(
  e2e: E2eApp,
  label: string,
  limits: PlanLimits = {},
  // Route-level `@RequireFeature(key)` (FeatureGuard) reads a raw per-tenant
  // `feature_flags` row that defaults to DISABLED when absent — a SEPARATE,
  // simpler mechanism from FeatureResolverService's plan/dependency/quota
  // resolution (see FND-033). Under PAID mode a gated route 403s unless its
  // key is listed here. Empty by default — pass e.g. ['campaigns'] for any
  // route carrying that decorator.
  features: string[] = [],
): Promise<SubscribedOwnerFixture> {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const tenants = e2e.dataSource.getRepository(Tenant);
  const users = e2e.dataSource.getRepository(User);
  const roles = e2e.dataSource.getRepository(Role);
  const userRoles = e2e.dataSource.getRepository(UserRole);
  const plans = e2e.dataSource.getRepository(SubscriptionPlan);
  const subscriptions = e2e.dataSource.getRepository(Subscription);

  const tenant = await tenants.save(
    tenants.create({
      name: `E2E Sub Clinic ${suffix}`,
      slug: `e2e-sub-${suffix}`,
      contact_email: `e2e-sub-${suffix}@example.test`,
      approval_status: TenantApprovalStatus.APPROVED,
      is_active: true,
    }),
  );

  const role = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: 'owner' })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) {
    throw new Error(
      'Seeded system role "owner" not found — run the RBAC seed (src/seed) against the test database first.',
    );
  }

  const user = await users.save(
    users.create({
      tenant: { id: tenant.id } as Tenant,
      email: `owner-sub-${suffix}@example.test`,
      full_name: `E2E Sub Owner ${suffix}`,
      is_active: true,
    }),
  );
  await userRoles.save(userRoles.create({ user: { id: user.id } as User, role: { id: role.id } as Role }));

  const plan = await plans.save(
    plans.create({
      name: `E2E Plan ${suffix}`,
      price: '99.00',
      billing_cycle: BillingCycle.MONTHLY,
      is_active: true,
      is_custom: false,
      ...limits,
    }),
  );

  const now = new Date();
  const oneYearOut = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const subscription = await subscriptions.save(
    subscriptions.create({
      tenant: { id: tenant.id } as Tenant,
      plan: { id: plan.id } as SubscriptionPlan,
      status: SubscriptionStatus.ACTIVE,
      starts_at: now,
      ends_at: oneYearOut,
      auto_renew: true,
    }),
  );

  if (features.length > 0) {
    const flags = e2e.dataSource.getRepository(FeatureFlag);
    await flags.save(
      features.map((feature_key) =>
        flags.create({ tenant: { id: tenant.id } as Tenant, feature_key, is_enabled: true }),
      ),
    );
  }

  const token = await e2e.jwt.signAsync(
    { sub: user.id, tenantId: tenant.id, type: 'access' },
    {
      secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      expiresIn: '15m',
    },
  );

  return {
    tenantId: tenant.id,
    userId: user.id,
    token,
    email: user.email!,
    planId: plan.id,
    subscriptionId: subscription.id,
  };
}

/**
 * Directly seeds a `subscription_usage` row for the CURRENT period at an
 * exact value — for setting up an "already at N-1/N" boundary before racing
 * the last unit. Upserts (matches `UsageService.increment`'s own ON CONFLICT
 * shape) so it is safe to call before any real increment has happened yet.
 */
export async function seedUsage(
  e2e: E2eApp,
  tenantId: string,
  subscriptionId: string,
  column: 'ai_tokens_used' | 'whatsapp_messages_used' | 'appointments_used' | 'campaigns_used',
  amount: number,
): Promise<void> {
  const periodMonth = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  await e2e.dataSource.query(
    `INSERT INTO subscription_usage (tenant_id, subscription_id, period_month, ${column})
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (subscription_id, period_month)
     DO UPDATE SET ${column} = EXCLUDED.${column}`,
    [tenantId, subscriptionId, periodMonth, amount],
  );
}

/**
 * Deletes this fixture's subscription_usage + subscription + plan rows.
 * MUST run before `cleanupTenant` (which deletes the tenant row these FK to).
 * The plan is NOT tenant-scoped, so it is deleted by id, not by tenant.
 */
export async function cleanupSubscriptionFixture(
  e2e: E2eApp,
  tenantId: string,
  planId: string,
): Promise<void> {
  await e2e.dataSource.query(`DELETE FROM subscription_usage WHERE tenant_id = $1`, [tenantId]);
  await e2e.dataSource.query(`DELETE FROM subscriptions WHERE "tenantId" = $1`, [tenantId]);
  await e2e.dataSource.query(`DELETE FROM subscription_plans WHERE id = $1`, [planId]);
}
