import { Injectable } from '@nestjs/common';

import {
  FeatureResolverService,
  type ResolvedFeature,
} from '../subscription-billing/feature-resolver.service';

import { SupportClinicResolver } from './support-clinic.resolver';
import { isoOrNull } from './support-privacy.util';

/**
 * Subscription + feature/module diagnostics for a clinic.
 *
 * SINGLE SOURCE OF TRUTH. This service performs no entitlement reasoning of
 * its own — it calls `FeatureResolverService.resolveTenant`, the platform's
 * one effective-feature resolver, and PROJECTS its answer. That resolver
 * already composes `AccessControlService` (is the tenant allowed at all, and
 * why), `SubscriptionService` (current plan + effective status) and
 * `UsageService` (limits vs. usage), and already computes the exact
 * `blockedReason` a support agent needs. Re-deriving any of it here would
 * create a second source of truth that drifts from what the product actually
 * enforces — the failure mode where Support confidently tells a clinic
 * "your plan includes it" while the guard says otherwise.
 *
 * WHAT IS DELIBERATELY DROPPED from the resolver's own output:
 *   - `allowedPlanIds` — the plan-catalogue matrix is Super Admin pricing
 *     configuration; Support needs "is it included for THIS clinic", which is
 *     the boolean `planIncluded`, not the list of every plan that has it.
 *   - `visibility` / `isBeta` / `isDeprecated` — product-roadmap metadata, not
 *     operational state.
 * Internal platform cost, margins and pricing configuration never appear in
 * the resolver's output at all, so there is nothing to strip for those.
 *
 * Read-only by construction: nothing in this file writes, and Platform Support
 * holds no slug that could change a plan, extend a subscription, alter usage,
 * approve an upgrade request or toggle a feature flag.
 */
@Injectable()
export class SupportEntitlementService {
  constructor(
    private readonly clinics: SupportClinicResolver,
    private readonly features: FeatureResolverService,
  ) {}

  /**
   * "Why can't this clinic use the platform / this module right now?"
   *
   * Answers with the subscription block plus a rolled-up count of features
   * blocked by each distinct reason, so the console can show the headline
   * ("access blocked: subscription inactive") without loading the full feature
   * matrix.
   */
  async subscription(tenantId: string) {
    await this.clinics.assertExists(tenantId);
    const { subscription, features } = await this.features.resolveTenant(tenantId);

    const blockedByReason: Record<string, number> = {};
    for (const f of features) {
      if (f.available || !f.blockedReason) continue;
      blockedByReason[f.blockedReason] = (blockedByReason[f.blockedReason] ?? 0) + 1;
    }

    return {
      // `enforced === false` means the clinic is on free platform mode or has
      // an active super-admin free-access override — the single most common
      // explanation for "the limits aren't applying to us".
      accessAllowed: subscription.active,
      quotasEnforced: subscription.enforced,
      status: subscription.status,
      /** SUBSCRIPTION | FREE_OVERRIDE | PLATFORM_FREE_MODE | NONE. */
      accessSource: subscription.source,
      planId: subscription.planId,
      planName: subscription.planName,
      expiresAt: isoOrNull(subscription.expiresAt),
      usage: this.usageSummary(features),
      featuresTotal: features.length,
      featuresAvailable: features.filter((f) => f.available).length,
      featuresBlockedByReason: blockedByReason,
    };
  }

  /**
   * The full per-feature matrix, each row carrying the individual signals a
   * support agent reads off in order — platform default vs. clinic override,
   * plan inclusion, dependencies, usage — plus the resolver's own verdict.
   *
   * `reasonDetail` exists so the console never has to re-derive an explanation
   * from the flags (which is exactly how a second source of truth is born): the
   * backend states the reason, the frontend translates the enum.
   */
  async featureMatrix(tenantId: string) {
    await this.clinics.assertExists(tenantId);
    const { subscription, features } = await this.features.resolveTenant(tenantId);

    return {
      subscriptionStatus: subscription.status,
      accessAllowed: subscription.active,
      quotasEnforced: subscription.enforced,
      features: features.map((f) => this.toDiagnostic(f)),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private toDiagnostic(f: ResolvedFeature) {
    return {
      featureKey: f.featureKey,
      name: f.name,
      category: f.category,
      description: f.description,
      /** Effective on/off after the clinic override is applied to the default. */
      enabled: f.enabled,
      /** null = no clinic-level override; true/false = explicitly set by/for the clinic. */
      clinicOverride: f.override,
      /** Whether the clinic's CURRENT plan includes it (not which plans do). */
      planIncluded: f.planIncluded,
      dependencies: f.dependencies,
      missingDependencies: f.missingDependencies,
      dependenciesSatisfied: f.dependenciesSatisfied,
      usageMetric: f.usageMetric,
      usage: f.usage
        ? {
            used: f.usage.used,
            limit: f.usage.limit,
            remaining: f.usage.remaining,
            percentUsed: f.usage.percentUsed,
            exceeded: f.usage.exceeded,
          }
        : null,
      available: f.available,
      blockedReason: f.blockedReason,
    };
  }

  /**
   * Deduplicated usage lines across the feature matrix. Several features share
   * one metric (e.g. every AI capability meters `AI_TOKENS`), so listing them
   * per feature would show the same quota four times; the console wants one
   * row per metric.
   */
  private usageSummary(features: ResolvedFeature[]) {
    const byMetric = new Map<string, ResolvedFeature['usage']>();
    for (const f of features) {
      if (!f.usageMetric || !f.usage || byMetric.has(f.usageMetric)) continue;
      byMetric.set(f.usageMetric, f.usage);
    }
    return [...byMetric.entries()].map(([metric, line]) => ({
      metric,
      used: line?.used ?? 0,
      limit: line?.limit ?? null,
      remaining: line?.remaining ?? null,
      percentUsed: line?.percentUsed ?? null,
      exceeded: line?.exceeded ?? false,
    }));
  }
}
