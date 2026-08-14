import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { BillingModeService } from './billing-mode.service';
import { FreeAccessOverrideService } from './free-access-override.service';
import { FeatureFlagService, FlagState } from './feature-flag.service';
import {
  FEATURE_KEYS,
  FEATURE_REGISTRY,
  FeatureKey,
  grantCovers,
  isFeatureKey,
} from './feature-registry';
import {
  AccessSource,
  GrantProvenance,
  QuotaPolicy,
  TenantAccessDecision,
  deniedDecision,
} from './tenant-access-decision';
import { AccessCacheService } from './access-cache.service';
import {
  AccessPolicyModeService,
  DenialSite,
} from './access-policy-mode.service';

/**
 * @deprecated Use {@link TenantAccessDecision}. Retained so existing consumers
 * of `resolveAccess` keep compiling while they migrate.
 */
export interface AccessDecision {
  allowed: boolean;
  source: AccessSource;
  subscriptionId?: string;
  reason?: string;
  expiresAt?: Date | null;
}

/** Everything one round of reads yields, shared by `resolve`/`resolveAll`. */
interface AccessContext {
  base: BaseAccess;
  flags: Map<string, FlagState>;
  /** `feature_definitions.default_enabled`, by key. */
  defaults: Map<string, boolean>;
  /** `feature_plans` plan ids by key; absent/empty = available on all plans. */
  plans: Map<string, string[]>;
}

/** The tenant-wide half of the decision, before any capability is considered. */
interface BaseAccess {
  allowed: boolean;
  source: AccessSource;
  quotaPolicy: QuotaPolicy;
  subscriptionId?: string;
  planId?: string;
  reason?: string;
  expiresAt?: Date | null;
}

/**
 * THE authority on "may this tenant use this capability right now, and do plan
 * quotas apply to it?".
 *
 * Everything else consumes {@link TenantAccessDecision} — no guard, service,
 * worker or controller may ask "does this tenant have a subscription?" on its
 * own. That rule is the whole point: the question used to be spread across
 * `SubscriptionAccessGuard`, `FeatureGuard`, `FeatureResolverService` and three
 * `UsageService` methods, and they did not agree. A tenant admitted through a
 * super-admin feature override passed the route guard and was then refused by
 * the usage layer, which had re-derived the answer without the feature in hand.
 *
 * PRECEDENCE (first match wins):
 *   1. ADMINISTRATIVE SUSPENSION — an explicit `feature_flags.is_suspended`
 *      block. Outranks everything, including FREE mode and a paid plan,
 *      because it is the incident kill-switch and must not be defeatable by
 *      the tenant's billing state.
 *   2. PLATFORM FREE MODE        — the whole platform is ungated.
 *   3. ADMIN FREE ACCESS         — a tenant-wide `free_access_overrides` grant.
 *   4. ACTIVE SUBSCRIPTION       — a usable plan that includes the capability.
 *   5. FEATURE OVERRIDE          — a super-admin per-feature grant, covering
 *      the toggled key AND its registry-declared dependency closure, never
 *      anything else.
 *   6. DENIED.
 *
 * Fails closed everywhere: an unknown feature key, an unresolvable tenant, or
 * an error inside the chain produce a denial, never a grant.
 */
@Injectable()
export class AccessControlService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(FeatureDefinition)
    private readonly definitions: Repository<FeatureDefinition>,
    @InjectRepository(FeaturePlan)
    private readonly featurePlans: Repository<FeaturePlan>,
    private readonly billingMode: BillingModeService,
    private readonly overrides: FreeAccessOverrideService,
    private readonly featureFlags: FeatureFlagService,
    private readonly config: ConfigService,
    private readonly cache: AccessCacheService,
    private readonly policyMode: AccessPolicyModeService,
  ) {}

  // ──────────────────────────── The authority ──────────────────────────── //

  /**
   * Resolve the full decision, optionally scoped to one capability. Pass
   * `featureKey` whenever gating a specific capability; pass `null` for the
   * tenant-wide question ("does this clinic have platform access at all?"),
   * where a per-feature override must NOT stand in for a subscription.
   */
  async resolve(
    tenantId: string,
    featureKey: FeatureKey | null = null,
    manager?: EntityManager,
  ): Promise<TenantAccessDecision> {
    if (featureKey === null) {
      // Reuses an already-cached context when one is warm, but never populates
      // the cache from here — this path skips the catalog reads, so storing it
      // would poison a later per-feature resolution with a half-built context.
      const warm = manager
        ? undefined
        : this.cache.get<AccessContext>(tenantId);
      const base = warm?.base ?? (await this.resolveBase(tenantId, manager));
      return { ...base, tenantId, featureKey: null };
    }
    const ctx = await this.loadContext(tenantId, manager);
    return this.decide(tenantId, featureKey, ctx);
  }

  /**
   * Whether a denial must actually BLOCK, or is only being observed.
   *
   * Every enforcement point — the two HTTP guards, the worker gate, the AI and
   * WhatsApp execution seams, the realtime gateway — asks this instead of
   * branching on the rollout mode itself. One switch, one implementation: see
   * {@link AccessPolicyModeService}. In `enforce` (the default) this is always
   * `true` and costs a boolean read.
   */
  shouldBlock(decision: TenantAccessDecision, site: DenialSite): boolean {
    return this.policyMode.shouldBlock(decision, site);
  }

  /**
   * Drops the tenant's cached access state here and on every other replica.
   *
   * Exposed on the authority (rather than making every caller reach for
   * `AccessCacheService`) so "what invalidates access?" has one answer that
   * lives next to "what decides access?".
   */
  invalidate(tenantId: string): void {
    this.cache.invalidate(tenantId);
  }

  /**
   * Every capability's decision for one tenant, from ONE set of reads.
   *
   * `FeatureResolverService` needs the whole picture to render the tenant's
   * effective-features view, and the super-admin console asks for it per
   * clinic. Resolving key-by-key would multiply the same four queries by the
   * size of the catalog — and, worse, invite a second implementation of the
   * per-feature rules, which is exactly the duplication this class exists to
   * remove.
   */
  async resolveAll(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Map<FeatureKey, TenantAccessDecision>> {
    const ctx = await this.loadContext(tenantId, manager);
    const out = new Map<FeatureKey, TenantAccessDecision>();
    for (const key of FEATURE_KEYS) {
      out.set(key, this.decide(tenantId, key, ctx));
    }
    return out;
  }

  /** The per-capability rules. Pure: every read already happened in `ctx`. */
  private decide(
    tenantId: string,
    featureKey: FeatureKey,
    ctx: AccessContext,
  ): TenantAccessDecision {
    const { base, flags } = ctx;

    const spec = FEATURE_REGISTRY[featureKey];
    if (!spec) {
      // Unreachable via the typed `@RequireFeature`, but reachable from a stale
      // DB row or an internal caller — deny rather than guess.
      return deniedDecision(tenantId, featureKey, 'Unknown feature key');
    }

    // 1. Administrative suspension outranks every grant path below.
    if (!spec.alwaysOn && flags.get(featureKey)?.suspended) {
      return deniedDecision(
        tenantId,
        featureKey,
        'Feature is administratively suspended for this tenant',
      );
    }

    // An always-on capability (billing, support, the workspace shell) is never
    // gated — a denied tenant still has to reach a plan and pay for one, or a
    // denial becomes a dead end with no route back.
    if (spec.alwaysOn) {
      return {
        allowed: true,
        tenantId,
        featureKey,
        source: base.source,
        subscriptionId: base.subscriptionId,
        planId: base.planId,
        // No plan means nothing to meter — never BLOCKED, which would
        // contradict `allowed: true`.
        quotaPolicy: base.allowed
          ? base.quotaPolicy
          : QuotaPolicy.UNMETERED_BY_PLAN,
        expiresAt: base.expiresAt,
      };
    }

    // 2/3. FREE mode and a tenant-wide admin grant both admit every
    // capability; there is no plan to check inclusion against.
    if (
      base.allowed &&
      (base.source === AccessSource.PLATFORM_FREE_MODE ||
        base.source === AccessSource.ADMIN_FREE_ACCESS)
    ) {
      return { ...base, tenantId, featureKey };
    }

    // 4. A usable subscription grants the capability when the plan includes it
    // and it is switched on for this tenant.
    if (base.allowed && base.source === AccessSource.ACTIVE_SUBSCRIPTION) {
      const on = this.isFeatureOn(featureKey, flags.get(featureKey), ctx);
      const included = this.planIncludes(featureKey, base.planId ?? null, ctx);
      if (on && included) {
        return { ...base, tenantId, featureKey };
      }
      // A paying tenant whose plan does not cover this capability still holds
      // platform access, so a per-feature grant below can still apply — exactly
      // as it would for a tenant with no plan at all.
    }

    // 5. A super-admin per-feature grant, scoped to the toggled key and the
    // dependencies that key cannot function without.
    const grant = this.findGrant(featureKey, flags);
    if (grant) {
      return {
        allowed: true,
        tenantId,
        featureKey,
        source: AccessSource.FEATURE_OVERRIDE,
        quotaPolicy: QuotaPolicy.UNMETERED_BY_PLAN,
        grantedVia: grant,
      };
    }

    // 6. Denied.
    return deniedDecision(
      tenantId,
      featureKey,
      base.allowed
        ? `Subscription does not include "${featureKey}", and no administrative grant exists`
        : (base.reason ??
            'No active subscription, free-access override, or free platform mode'),
    );
  }

  /**
   * Throws 403 unless the tenant may use this capability right now, and
   * returns the decision so a caller can reuse it without resolving twice.
   *
   * The client sees the friendly NO_ACTIVE_SUBSCRIPTION copy plus the access
   * source; `decision.reason` names subscription state, so it stays in
   * `internalContext` (server logs) and is never returned.
   */
  async assertAccess(
    tenantId: string,
    featureKey: FeatureKey | null = null,
    site: DenialSite = { surface: 'service', detail: 'assertAccess' },
  ): Promise<TenantAccessDecision> {
    const decision = await this.resolve(tenantId, featureKey);
    if (!decision.allowed && this.shouldBlock(decision, site)) {
      throw new AppError(ErrorCode.NO_ACTIVE_SUBSCRIPTION, {
        publicContext: { source: decision.source, featureKey },
        internalContext: { reason: decision.reason },
      });
    }
    return decision;
  }

  // ─────────────────────── Backwards-compatible shims ──────────────────── //

  /** @deprecated Call {@link resolve}. */
  async resolveAccess(
    tenantId: string,
    featureKey?: string | readonly string[],
    manager?: EntityManager,
  ): Promise<AccessDecision> {
    const d = await this.resolve(
      tenantId,
      this.firstKnownKey(featureKey),
      manager,
    );
    return {
      allowed: d.allowed,
      source: d.source,
      subscriptionId: d.subscriptionId,
      reason: d.reason,
      expiresAt: d.expiresAt,
    };
  }

  /** @deprecated Call {@link assertAccess}. */
  async assertUsable(tenantId: string, featureKey?: string): Promise<void> {
    await this.assertAccess(tenantId, this.firstKnownKey(featureKey));
  }

  /**
   * Whether PLAN QUOTAS apply — i.e. the decision's `quotaPolicy` is
   * `PLAN_ENFORCED`.
   *
   * Derived, never re-computed. Every non-subscription grant path admits a
   * tenant with no plan, and a limit cannot be enforced against a plan that
   * does not exist. A DENIED tenant is still reported as enforced (`true`) so
   * the usage layer keeps failing closed on worker and bot paths that never
   * pass through a guard.
   */
  async isEnforced(
    tenantId: string,
    manager?: EntityManager,
    featureKey?: string | readonly string[],
  ): Promise<boolean> {
    const key = this.firstKnownKey(featureKey);

    // Fast path: with no capability named, the answer collapses to these two
    // tenant-wide checks and the subscription read can be skipped entirely.
    // Matters because PlatformUsageService calls this once PER TENANT across a
    // listing; the full chain there would multiply the fan-out.
    if (key === null) {
      if (!(await this.billingMode.isPaidMode(manager))) return false;
      return !(await this.overrides.hasActive(tenantId, manager));
    }

    const decision = await this.resolve(tenantId, key, manager);
    // Fail closed: a DENIED tenant is reported as enforced, never unmetered.
    // The usage layer is the ONLY gate on worker and bot paths that never pass
    // through a guard, so answering "not enforced" for a refused tenant would
    // hand those paths an unlimited allowance.
    if (!decision.allowed) return true;
    return decision.quotaPolicy === QuotaPolicy.PLAN_ENFORCED;
  }

  /**
   * FND-031/T082 — the NARROW, write-specific gate: true unless the tenant's
   * effective state is GRACE_EXPIRED. Deliberately separate from the access
   * decision, which governs reads too: read access must survive grace expiry
   * (FR-B007d), so this must never be folded into `resolve`.
   */
  async isBillableAllowed(tenantId: string): Promise<boolean> {
    if (!(await this.billingMode.isPaidMode())) return true;
    if (await this.overrides.hasActive(tenantId)) return true;
    const subscription = await this.findCurrent(tenantId);
    if (!subscription) return true; // no subscription at all is `resolve`'s concern
    return this.effective(subscription) !== SubscriptionStatus.GRACE_EXPIRED;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** Mode → tenant-wide admin grant → usable subscription → none. */
  private async resolveBase(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<BaseAccess> {
    if (!(await this.billingMode.isPaidMode(manager))) {
      return {
        allowed: true,
        source: AccessSource.PLATFORM_FREE_MODE,
        quotaPolicy: QuotaPolicy.UNMETERED_PLATFORM_FREE,
      };
    }

    const override = await this.overrides.getActive(tenantId, manager);
    if (override) {
      return {
        allowed: true,
        source: AccessSource.ADMIN_FREE_ACCESS,
        quotaPolicy: QuotaPolicy.UNMETERED_ADMIN_GRANT,
        expiresAt: override.ends_at,
      };
    }

    const subscription = await this.findCurrent(tenantId, manager);
    if (subscription && this.isUsable(subscription)) {
      return {
        allowed: true,
        source: AccessSource.ACTIVE_SUBSCRIPTION,
        quotaPolicy: QuotaPolicy.PLAN_ENFORCED,
        subscriptionId: subscription.id,
        planId: subscription.plan?.id,
        expiresAt: subscription.ends_at,
      };
    }

    return {
      allowed: false,
      source: AccessSource.DENIED,
      quotaPolicy: QuotaPolicy.BLOCKED,
      reason: subscription
        ? `Subscription is not active (status: ${this.effective(subscription)})`
        : 'No active subscription, free-access override, or free platform mode',
    };
  }

  /**
   * Is the capability switched on for this tenant?
   *
   * An authoritative grant turns it on; otherwise the catalog default applies.
   * Note what is NOT here: a stored `is_enabled = false` does not turn a
   * capability off — "off" is `is_suspended`, checked earlier. Overloading the
   * two is what let a cleared override silently de-provision a paying clinic.
   */
  private isFeatureOn(
    featureKey: FeatureKey,
    state: FlagState | undefined,
    ctx: AccessContext,
  ): boolean {
    if (state?.granted) return true;
    const def = ctx.defaults.get(featureKey);
    return def ?? FEATURE_REGISTRY[featureKey].defaultEnabled;
  }

  /**
   * Plan entitlement. NO `feature_plans` rows for a key means "available on
   * every plan" — the historical default, preserved so flipping the platform
   * to PAID cannot retroactively strip capabilities from paying clinics before
   * an operator has configured the matrix.
   */
  private planIncludes(
    featureKey: FeatureKey,
    planId: string | null,
    ctx: AccessContext,
  ): boolean {
    const allowed = ctx.plans.get(featureKey);
    if (!allowed || allowed.length === 0) return true;
    if (!planId) return false; // restricted, but to what we cannot tell → deny
    return allowed.includes(planId);
  }

  /**
   * One round of reads backing every capability decision for a tenant.
   *
   * Deliberately loads the WHOLE catalog rather than the one key asked about:
   * `feature_definitions` and `feature_plans` are small, bounded tables, and
   * paying two fixed queries lets `resolve` and `resolveAll` share one code
   * path. Per-key reads would have made the bulk view N times more expensive
   * and tempted a separate bulk implementation to avoid that cost.
   */
  private async loadContext(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<AccessContext> {
    // A transaction NEVER reads the cache: a caller inside one may have just
    // written the flag being resolved (the super-admin toggle re-reads its own
    // write to build the audit record), and must observe it.
    if (!manager) {
      const cached = this.cache.get<AccessContext>(tenantId);
      if (cached) return cached;
    }

    const defsRepo = manager
      ? manager.getRepository(FeatureDefinition)
      : this.definitions;
    const plansRepo = manager
      ? manager.getRepository(FeaturePlan)
      : this.featurePlans;

    const [base, flags, defs, planRows] = await Promise.all([
      this.resolveBase(tenantId, manager),
      this.featureFlags.getStates(tenantId, manager),
      defsRepo.find(),
      plansRepo.find(),
    ]);

    const defaults = new Map<string, boolean>();
    for (const d of defs) defaults.set(d.feature_key, d.default_enabled);

    const plans = new Map<string, string[]>();
    for (const p of planRows) {
      plans.set(p.feature_key, [
        ...(plans.get(p.feature_key) ?? []),
        p.plan_id,
      ]);
    }

    const ctx: AccessContext = { base, flags, defaults, plans };
    if (!manager) this.cache.set(tenantId, ctx);
    return ctx;
  }

  /**
   * Find an authoritative grant covering `featureKey` — set directly on it, or
   * set on a capability that declares it as a dependency.
   *
   * The closure is what makes an override usable: enabling WhatsApp for a
   * tenant with no subscription has to make the WhatsApp inbox work, and that
   * inbox reads conversations and customer records. The closure is declared in
   * code, reviewed in PRs and surfaced in the admin UI, so every capability an
   * override opens is explicit — it never widens to anything undeclared.
   */
  private findGrant(
    featureKey: FeatureKey,
    flags: Map<string, FlagState>,
  ): GrantProvenance | null {
    if (flags.get(featureKey)?.granted) return { directly: true };

    for (const [key, state] of flags) {
      if (!state.granted || !isFeatureKey(key)) continue;
      if (grantCovers(key, featureKey)) {
        return { directly: false, viaDependencyOf: key };
      }
    }
    return null;
  }

  /** First value that is a real registry key, else null. */
  private firstKnownKey(
    featureKey?: string | readonly string[] | null,
  ): FeatureKey | null {
    if (!featureKey) return null;
    const keys = typeof featureKey === 'string' ? [featureKey] : featureKey;
    for (const k of keys) if (isFeatureKey(k)) return k;
    return null;
  }

  /**
   * The tenant's current subscription: newest non-deleted, plan loaded.
   *
   * Deliberately does NOT filter out CANCELLED — a newer cancelled row must
   * mask an older active one, or cancelling would silently fall back to a
   * stale subscription and keep granting access.
   */
  private findCurrent(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Subscription | null> {
    const repo = manager
      ? manager.getRepository(Subscription)
      : this.subscriptions;
    return repo.findOne({
      where: { tenant: { id: tenantId }, deleted_at: IsNull() },
      relations: { plan: true },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * FND-031 — usable (the BROAD platform-access gate) means anything
   * non-terminal: ACTIVE, TRIAL, PAST_DUE ("expired-in-grace" — full
   * capabilities, unchanged), AND GRACE_EXPIRED (read access preserved —
   * FR-B007d; only billable actions are refused there, via
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
   * `SubscriptionService.getEffectiveStatus`: ACTIVE/TRIAL past `ends_at`
   * reads as PAST_DUE; PAST_DUE whose grace window has elapsed reads as
   * GRACE_EXPIRED. Never a race against the background transition sweep
   * (`subscriptions.processor.ts`).
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
        const graceDays = this.config.get<number>(
          'SUBSCRIPTION_GRACE_DAYS',
          14,
        );
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
