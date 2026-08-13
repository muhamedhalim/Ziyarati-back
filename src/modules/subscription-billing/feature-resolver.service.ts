import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import {
  AUTHORITATIVE_FLAG_SOURCES,
  FeatureFlag,
} from '../../entities/SaaS-Core/FeatureFlag';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureDependency } from '../../entities/SaaS-Core/FeatureDependency';

import { AccessControlService } from './access-control.service';
import { SubscriptionService } from './subscription.service';
import { UsageService } from './usage.service';
import { FeatureKey, isFeatureKey } from './feature-registry';
import {
  AccessSource,
  QuotaPolicy,
  TenantAccessDecision,
} from './tenant-access-decision';

/** Maps a feature's `usage_metric` to a `UsageService.getBreakdown` line. */
const METRIC_TO_BREAKDOWN: Record<string, keyof BreakdownMetrics> = {
  AI_TOKENS: 'aiTokens',
  WHATSAPP_MESSAGES: 'whatsappMessages',
  APPOINTMENTS: 'appointments',
  CAMPAIGNS: 'campaigns',
};

interface BreakdownLine {
  used: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  exceeded: boolean;
}
interface BreakdownMetrics {
  aiTokens: BreakdownLine;
  whatsappMessages: BreakdownLine;
  appointments: BreakdownLine;
  campaigns: BreakdownLine;
}

export type BlockedReason =
  | 'subscription_inactive'
  | 'disabled'
  | 'plan_restricted'
  | 'dependency_missing'
  | 'quota_exceeded'
  | 'suspended'
  | null;

export interface ResolvedFeature {
  featureKey: string;
  name: string;
  category: string;
  description: string | null;
  visibility: string;
  isBeta: boolean;
  isDeprecated: boolean;
  enabled: boolean;
  override: boolean | null;
  /** Who recorded the override, when there is one. */
  overrideSource: string | null;
  suspended: boolean;
  allowedPlanIds: string[];
  planIncluded: boolean;
  dependencies: string[];
  missingDependencies: string[];
  dependenciesSatisfied: boolean;
  usageMetric: string | null;
  usage: BreakdownLine | null;
  available: boolean;
  /** Set when access came from an override on a DIFFERENT capability. */
  grantedVia: string | null;
  blockedReason: BlockedReason;
}

export interface ResolvedSubscription {
  active: boolean;
  enforced: boolean;
  status: string;
  source: string;
  planId: string | null;
  planName: string | null;
  expiresAt: string | null;
}

export interface TenantFeatureResolution {
  subscription: ResolvedSubscription;
  features: ResolvedFeature[];
}

/**
 * The PRESENTATION view of the access policy: one row per catalog feature,
 * with everything the admin console and the tenant's own settings screen need
 * to explain the current state.
 *
 * It decides nothing. `available` comes verbatim from
 * `AccessControlService.resolveAll`, so route gating and this view cannot
 * disagree — they are the same computation. Previously this service ran its
 * own chain (calling `resolveAccess` WITHOUT a feature key and then rescuing
 * per-feature overrides by hand), which is precisely the duplicated
 * entitlement logic that let the two drift apart.
 *
 * `blockedReason` is the one thing computed here, because it is a LABEL, not a
 * verdict: it explains a denial the policy already made.
 */
@Injectable()
export class FeatureResolverService {
  private readonly logger = new Logger(FeatureResolverService.name);

  constructor(
    @InjectRepository(FeatureDefinition)
    private readonly definitions: Repository<FeatureDefinition>,
    @InjectRepository(FeatureFlag)
    private readonly flags: Repository<FeatureFlag>,
    @InjectRepository(FeaturePlan)
    private readonly featurePlans: Repository<FeaturePlan>,
    @InjectRepository(FeatureDependency)
    private readonly dependencies: Repository<FeatureDependency>,
    private readonly access: AccessControlService,
    private readonly subscriptions: SubscriptionService,
    private readonly usage: UsageService,
  ) {}

  async resolveTenant(tenantId: string): Promise<TenantFeatureResolution> {
    const [decisions, base, subView, breakdown, defs, overrides, plans, deps] =
      await Promise.all([
        this.access.resolveAll(tenantId),
        this.access.resolve(tenantId, null),
        this.subscriptions.getCurrent(tenantId).catch(() => null),
        this.usage.getBreakdown(tenantId).catch(() => null) as Promise<{
          planId: string;
          planName: string;
          metrics: BreakdownMetrics;
        } | null>,
        this.definitions.find({ order: { category: 'ASC', name: 'ASC' } }),
        this.flags.find({ where: { tenant: { id: tenantId } } }),
        this.featurePlans.find(),
        this.dependencies.find(),
      ]);

    const enforced = base.quotaPolicy === QuotaPolicy.PLAN_ENFORCED;
    const currentPlanId = base.planId ?? breakdown?.planId ?? null;

    const flagByKey = new Map(overrides.map((o) => [o.feature_key, o]));
    const planMap = new Map<string, string[]>();
    for (const p of plans) {
      planMap.set(p.feature_key, [
        ...(planMap.get(p.feature_key) ?? []),
        p.plan_id,
      ]);
    }
    const depMap = new Map<string, string[]>();
    for (const d of deps) {
      depMap.set(d.feature_key, [
        ...(depMap.get(d.feature_key) ?? []),
        d.requires_key,
      ]);
    }

    const features: ResolvedFeature[] = defs.map((d) => {
      const flag = flagByKey.get(d.feature_key);
      const authoritative =
        flag && AUTHORITATIVE_FLAG_SOURCES.includes(flag.source);
      // Only an authoritative row is an "override" — a tenant-written row is a
      // local preference with no bearing on access, and showing it as an
      // override would tell an operator the tenant had been granted something
      // it had not.
      const override = authoritative ? flag.is_enabled : null;
      const suspended = flag?.is_suspended === true;

      const decision = isFeatureKey(d.feature_key)
        ? decisions.get(d.feature_key)
        : undefined;

      const allowedPlanIds = planMap.get(d.feature_key) ?? [];
      const planIncluded =
        allowedPlanIds.length === 0 ||
        !enforced ||
        (!!currentPlanId && allowedPlanIds.includes(currentPlanId));
      const directDeps = depMap.get(d.feature_key) ?? [];
      const depResult = this.resolveDeps(d.feature_key, depMap, decisions);

      const usage = this.usageLine(d.usage_metric, breakdown?.metrics);
      const enabled = override ?? d.default_enabled;

      // `available` is the policy's verdict, not ours. A key with no registry
      // entry (a legacy row the sync no longer owns) resolves to `undefined`
      // and is reported unavailable — fail closed.
      const available = decision?.allowed === true;

      return {
        featureKey: d.feature_key,
        name: d.name,
        category: d.category,
        description: d.description ?? null,
        visibility: d.visibility,
        isBeta: d.is_beta,
        isDeprecated: d.is_deprecated,
        enabled,
        override,
        overrideSource: flag?.source ?? null,
        suspended,
        allowedPlanIds,
        planIncluded,
        dependencies: directDeps,
        missingDependencies: depResult.missing,
        dependenciesSatisfied: depResult.satisfied,
        usageMetric: d.usage_metric ?? null,
        usage,
        available,
        grantedVia: decision?.grantedVia?.viaDependencyOf ?? null,
        blockedReason: available
          ? null
          : this.explain({
              decision,
              suspended,
              enabled,
              planIncluded,
              depsSatisfied: depResult.satisfied,
              quotaExceeded: enforced && !!usage?.exceeded,
            }),
      };
    });

    return {
      subscription: {
        active: base.allowed,
        enforced,
        status: subView?.effectiveStatus ?? this.sourceStatus(base.source),
        source: base.source,
        planId: currentPlanId,
        planName: breakdown?.planName ?? null,
        expiresAt: base.expiresAt
          ? new Date(base.expiresAt).toISOString()
          : null,
      },
      features,
    };
  }

  /** Direct + transitive dependency keys required by a feature. */
  async dependenciesOf(featureKey: string): Promise<string[]> {
    const deps = await this.dependencies.find();
    const depMap = new Map<string, string[]>();
    for (const d of deps) {
      depMap.set(d.feature_key, [
        ...(depMap.get(d.feature_key) ?? []),
        d.requires_key,
      ]);
    }
    const out = new Set<string>();
    const walk = (key: string, seen: Set<string>) => {
      for (const req of depMap.get(key) ?? []) {
        if (seen.has(req)) continue; // cycle guard
        out.add(req);
        walk(req, new Set([...seen, key]));
      }
    };
    walk(featureKey, new Set([featureKey]));
    return [...out];
  }

  // ── Private ────────────────────────────────────────────────────────────

  /**
   * Why the policy said no. A LABEL for a verdict already made — ordered from
   * most specific cause to least, so an operator sees the thing they can act
   * on rather than a generic "subscription inactive" on top of a suspension.
   */
  private explain(input: {
    decision?: TenantAccessDecision;
    suspended: boolean;
    enabled: boolean;
    planIncluded: boolean;
    depsSatisfied: boolean;
    quotaExceeded: boolean;
  }): BlockedReason {
    if (input.suspended) return 'suspended';
    if (!input.enabled) return 'disabled';
    if (!input.planIncluded) return 'plan_restricted';
    if (!input.depsSatisfied) return 'dependency_missing';
    if (input.quotaExceeded) return 'quota_exceeded';
    if (input.decision && input.decision.source === AccessSource.DENIED) {
      return 'subscription_inactive';
    }
    return 'disabled';
  }

  /**
   * A dependency counts as satisfied when the POLICY grants it — the same
   * question the dependent capability's own routes will ask. Judging it from
   * raw catalog state instead (as this used to) reported dependencies missing
   * for tenants who in fact held them through an override.
   */
  private resolveDeps(
    key: string,
    depMap: Map<string, string[]>,
    decisions: Map<FeatureKey, TenantAccessDecision>,
  ): { satisfied: boolean; missing: string[] } {
    const missing = new Set<string>();
    const walk = (k: string, seen: Set<string>): void => {
      for (const req of depMap.get(k) ?? []) {
        if (seen.has(req)) {
          this.logger.warn(`Circular feature dependency detected at "${req}"`);
          continue;
        }
        const granted =
          isFeatureKey(req) && decisions.get(req)?.allowed === true;
        if (!granted) missing.add(req);
        walk(req, new Set([...seen, k]));
      }
    };
    walk(key, new Set([key]));
    return { satisfied: missing.size === 0, missing: [...missing] };
  }

  private usageLine(
    usageMetric: string | undefined,
    metrics?: BreakdownMetrics,
  ): BreakdownLine | null {
    if (!usageMetric || !metrics) return null;
    const bkey = METRIC_TO_BREAKDOWN[usageMetric];
    return bkey ? metrics[bkey] : null;
  }

  /**
   * Display status when there is no subscription row to read one from.
   *
   * Compares against `AccessSource` VALUES. The previous version compared
   * against the uppercase member names (`'PLATFORM_FREE_MODE'`) while the enum
   * values are lowercase, so both branches were dead and a tenant on a free
   * platform was reported as `NONE`.
   */
  private sourceStatus(source: AccessSource | string): string {
    if (source === AccessSource.PLATFORM_FREE_MODE) return 'FREE';
    if (source === AccessSource.ADMIN_FREE_ACCESS) return 'OVERRIDE';
    if (source === AccessSource.FEATURE_OVERRIDE) return 'FEATURE_OVERRIDE';
    return 'NONE';
  }
}
