import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { FeatureFlagService } from './feature-flag.service';
import { AccessSource } from './platform-billing.constants';

export interface AccessDecision {
  allowed: boolean;
  source: AccessSource;
  /** Present when access came from a paid subscription. */
  subscriptionId?: string;
  /** Human-readable reason, primarily for denials. */
  reason?: string;
  /** When access is time-bounded (override end / subscription end). */
  expiresAt?: Date | null;
}

/**
 * The single source of truth for "can this tenant use the platform right now?".
 *
 * Resolution priority (fixed, documented in platform-billing.constants):
 *   1. GLOBAL MODE     — if the platform is in FREE mode, everyone is allowed.
 *   2. FREE OVERRIDE    — an active super-admin override allows the tenant,
 *                      OUTRANKING (overriding) the paid-subscription check.
 *   3. PAID SUBSCRIPTION — otherwise a usable (ACTIVE/TRIAL, not expired)
 *                      subscription is required.
 *   4. FEATURE OVERRIDE — only when the caller names the specific `featureKey`
 *                      its route is gated on: a tenant-specific
 *                      `feature_flags` override (super-admin, per
 *                      `/platform/feature-flags`) grants access to THAT
 *                      route only, even with no usable subscription. It never
 *                      widens to other features/routes — those still fall
 *                      through to the denial below.
 *
 * This service depends only on FeatureFlagService beyond its own repo (a leaf
 * service with no further deps), so it stays injectable by
 * SubscriptionService/FeatureResolverService/guards without creating a cycle.
 * It is the only place the priority rules live.
 */
@Injectable()
export class AccessControlService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly billingMode: BillingModeService,
    private readonly overrides: FreeAccessOverrideService,
    private readonly featureFlags: FeatureFlagService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve the access decision for a tenant, applying the full priority
   * chain. Pass `featureKey` when the caller is gating a specific
   * feature-scoped route (e.g. `SubscriptionAccessGuard` reading the same
   * route's `@RequireFeature()`) so step 4 can apply; omit it for the
   * platform-wide check, where a feature override must never substitute for
   * a real subscription.
   */
  async resolveAccess(
    tenantId: string,
    featureKey?: string | readonly string[],
    manager?: EntityManager,
  ): Promise<AccessDecision> {
    // 1. Global free mode short-circuits everything.
    if (!(await this.billingMode.isPaidMode(manager))) {
      return { allowed: true, source: AccessSource.PLATFORM_FREE_MODE };
    }

    // 2. An active free-access override outranks the paid check.
    const override = await this.overrides.getActive(tenantId, manager);
    if (override) {
      return {
        allowed: true,
        source: AccessSource.FREE_OVERRIDE,
        expiresAt: override.ends_at,
      };
    }

    // 3. Paid mode, no override → require a usable subscription.
    const subscription = await this.findCurrent(tenantId, manager);
    if (subscription && this.isUsable(subscription)) {
      return {
        allowed: true,
        source: AccessSource.SUBSCRIPTION,
        subscriptionId: subscription.id,
        expiresAt: subscription.ends_at,
      };
    }

    // 4. No usable subscription — a tenant-specific override for THIS route's
    // own required feature still grants access to it (and only it). Reuses
    // FeatureFlagService's existing `feature_flags` store — the exact same
    // per-tenant row FeatureResolverService/FeatureGuard read — rather than
    // a second override concept.
    if (await this.anyFeatureEnabled(tenantId, featureKey, manager)) {
      return { allowed: true, source: AccessSource.FEATURE_OVERRIDE };
    }

    return {
      allowed: false,
      source: AccessSource.NONE,
      reason: subscription
        ? `Subscription is not active (status: ${this.effective(subscription)})`
        : 'No active subscription, free-access override, or free platform mode',
    };
  }

  /**
   * Throws 403 unless the tenant currently has access (any of the paths
   * above). Uses the dedicated NO_ACTIVE_SUBSCRIPTION code so clients can
   * show a friendly "choose a plan" message instead of the technical
   * `decision.reason` — that stays server-side only (internalContext), never
   * in the client-facing message.
   *
   * `featureKey` — see {@link resolveAccess}; pass the route's own
   * `@RequireFeature()` key (SubscriptionAccessGuard does) so a tenant
   * override for exactly that feature can grant access.
   */
  async assertUsable(tenantId: string, featureKey?: string): Promise<void> {
    const decision = await this.resolveAccess(tenantId, featureKey);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.NO_ACTIVE_SUBSCRIPTION, {
        publicContext: { source: decision.source },
        internalContext: { reason: decision.reason },
      });
    }
  }

  /**
   * Whether paid enforcement (plan quotas / feature gating) currently applies
   * to this tenant.
   *
   * THE RULE: plan quotas apply exactly when a paid SUBSCRIPTION is what
   * granted access. Every other grant path in `resolveAccess` — free mode, a
   * super-admin free-access override, or a per-feature override — admits a
   * tenant that has no plan at all, and a limit cannot be enforced against a
   * plan that does not exist. Enforcement is therefore DERIVED from the same
   * decision the route guard used, never re-derived independently: that
   * asymmetry is precisely the bug this fixes (the guard admitted a tenant via
   * FEATURE_OVERRIDE, then `UsageService` demanded a subscription anyway and
   * threw `No active subscription found for this tenant`).
   *
   * `featureKey` — pass the feature(s) the metered action belongs to (see
   * `USAGE_METRIC_FEATURE_KEYS`), i.e. the same question the route's
   * `@RequireFeature()` asked. Scoped: an override for one feature never
   * unmeters another.
   *
   * DENIED still means enforced (`true`), never unmetered — so a tenant with
   * no subscription and no override keeps failing closed at the usage layer,
   * which is the only gate on worker/bot paths that never pass through
   * `SubscriptionAccessGuard`.
   *
   * FND-047: pass the caller's `manager` when this is reached from inside an
   * open `dataSource.transaction()` (`UsageService.incrementIfWithinLimit`'s
   * campaign/appointment call sites) so the nested reads reuse that
   * transaction's own connection instead of each borrowing a separate one from
   * the pool — the mechanism behind the FND-047 concurrency hang.
   */
  async isEnforced(
    tenantId: string,
    manager?: EntityManager,
    featureKey?: string | readonly string[],
  ): Promise<boolean> {
    // Fast path: with no feature key, `resolveAccess`'s step 4 can never fire,
    // so its verdict collapses to exactly these two checks — provably the same
    // answer without the subscription read. Matters because
    // PlatformUsageService calls this once PER TENANT across a listing; going
    // through the full chain there would double that fan-out.
    if (!featureKey || (Array.isArray(featureKey) && featureKey.length === 0)) {
      if (!(await this.billingMode.isPaidMode(manager))) return false;
      return !(await this.overrides.hasActive(tenantId, manager));
    }

    const decision = await this.resolveAccess(tenantId, featureKey, manager);
    if (!decision.allowed) return true; // fail closed — see docstring
    return decision.source === AccessSource.SUBSCRIPTION;
  }

  /**
   * FND-031/T082 — the NARROW, write-specific gate: true unless the tenant's
   * effective state is GRACE_EXPIRED. Deliberately separate from
   * `assertUsable`/`isEnforced` (which govern the WHOLE platform, reads
   * included) — read access must be preserved even once grace-expired
   * (FR-B007d), so this must never be folded into those.
   */
  async isBillableAllowed(tenantId: string): Promise<boolean> {
    if (!(await this.billingMode.isPaidMode())) return true;
    if (await this.overrides.hasActive(tenantId)) return true;
    const subscription = await this.findCurrent(tenantId);
    if (!subscription) return true; // no subscription = AccessControlService's broader gate already refused the request
    return this.effective(subscription) !== SubscriptionStatus.GRACE_EXPIRED;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private findCurrent(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Subscription | null> {
    const repo = manager
      ? manager.getRepository(Subscription)
      : this.subscriptions;
    return repo.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * True when ANY of the supplied feature keys is enabled for the tenant.
   * Sequential (not `Promise.all`) so the common single-key case costs one
   * query and a hit on the first key short-circuits the rest — and so every
   * read stays on `manager`'s single connection when one was threaded in.
   */
  private async anyFeatureEnabled(
    tenantId: string,
    featureKey: string | readonly string[] | undefined,
    manager?: EntityManager,
  ): Promise<boolean> {
    if (!featureKey) return false;
    const keys = typeof featureKey === 'string' ? [featureKey] : featureKey;
    for (const key of keys) {
      if (await this.featureFlags.isEnabled(tenantId, key, manager))
        return true;
    }
    return false;
  }

  /**
   * FND-031 — usable (the BROAD platform-access gate) means anything
   * non-terminal: ACTIVE, TRIAL, PAST_DUE ("expired-in-grace" — full
   * capabilities, unchanged), AND GRACE_EXPIRED (read access preserved —
   * FR-B007d; only billable/usage-increasing actions are refused there, via
   * `isBillableAllowed`, never here). Only CANCELLED/SUSPENDED are not usable.
   */
  private isUsable(subscription: Subscription): boolean {
    const status = this.effective(subscription);
    return (
      status !== SubscriptionStatus.CANCELLED &&
      status !== SubscriptionStatus.SUSPENDED
    );
  }

  /**
   * Live-derives past the raw `status` column exactly like
   * `SubscriptionService.getEffectiveStatus` (duplicated rather than
   * depended-on — this service must stay dependency-free of
   * SubscriptionService/UsageService, see the class docstring): ACTIVE/TRIAL
   * past `ends_at` reads as PAST_DUE; PAST_DUE whose grace window has
   * elapsed reads as GRACE_EXPIRED. Never a race against the background
   * transition sweep (`subscriptions.processor.ts`).
   */
  private effective(subscription: Subscription): SubscriptionStatus {
    const now = new Date();
    if (
      subscription.status === SubscriptionStatus.CANCELLED ||
      subscription.status === SubscriptionStatus.SUSPENDED ||
      subscription.status === SubscriptionStatus.GRACE_EXPIRED
    ) {
      return subscription.status;
    }
    if (subscription.status === SubscriptionStatus.PAST_DUE) {
      if (subscription.grace_started_at) {
        const graceDays = this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14);
        const graceEndsAt = new Date(
          subscription.grace_started_at.getTime() + graceDays * 86_400_000,
        );
        if (graceEndsAt < now) return SubscriptionStatus.GRACE_EXPIRED;
      }
      return SubscriptionStatus.PAST_DUE;
    }
    if (subscription.ends_at < now) return SubscriptionStatus.PAST_DUE;
    return subscription.status;
  }
}
