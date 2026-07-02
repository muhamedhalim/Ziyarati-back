import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeatureFlag } from '../../entities/SaaS-Core/FeatureFlag';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureDependency } from '../../entities/SaaS-Core/FeatureDependency';

import { AccessControlService } from './access-control.service';
import { SubscriptionService } from './subscription.service';
import { UsageService } from './usage.service';

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
  allowedPlanIds: string[];
  planIncluded: boolean;
  dependencies: string[];
  missingDependencies: string[];
  dependenciesSatisfied: boolean;
  usageMetric: string | null;
  usage: BreakdownLine | null;
  available: boolean;
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
 * THE single effective-feature resolver. A feature is available only when ALL
 * hold: subscription active · plan includes it · globally enabled · tenant
 * override allows · dependencies satisfied · usage quota not exceeded.
 *
 * It never re-implements subscription or quota logic — it composes
 * {@link AccessControlService} (access + enforcement), {@link SubscriptionService}
 * (current plan/status), and {@link UsageService} (plan limits + usage). All
 * modules resolve feature availability through here.
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
    const [access, enforced, subView, breakdown, defs, overrides, plans, deps] =
      await Promise.all([
        this.access.resolveAccess(tenantId),
        this.access.isEnforced(tenantId),
        this.subscriptions.getCurrent(tenantId).catch(() => null),
        this.usage
          .getBreakdown(tenantId)
          .catch(() => null) as Promise<{
          planId: string;
          planName: string;
          metrics: BreakdownMetrics;
        } | null>,
        this.definitions.find({ order: { category: 'ASC', name: 'ASC' } }),
        this.flags.find({ where: { tenant: { id: tenantId } } }),
        this.featurePlans.find(),
        this.dependencies.find(),
      ]);

    const currentPlanId = breakdown?.planId ?? null;
    const overrideMap = new Map(overrides.map((o) => [o.feature_key, o.is_enabled]));
    const planMap = new Map<string, string[]>();
    for (const p of plans) {
      planMap.set(p.feature_key, [...(planMap.get(p.feature_key) ?? []), p.plan_id]);
    }
    const depMap = new Map<string, string[]>();
    for (const d of deps) {
      depMap.set(d.feature_key, [...(depMap.get(d.feature_key) ?? []), d.requires_key]);
    }

    // Base state per feature (enabled + plan inclusion) — used by the dep walk.
    const base = new Map<string, { enabled: boolean; planIncluded: boolean }>();
    for (const d of defs) {
      const override = overrideMap.has(d.feature_key)
        ? (overrideMap.get(d.feature_key) as boolean)
        : null;
      const enabled = override ?? d.default_enabled;
      const planIncluded = this.planIncluded(
        planMap.get(d.feature_key) ?? [],
        currentPlanId,
        enforced,
      );
      base.set(d.feature_key, { enabled, planIncluded });
    }

    const features: ResolvedFeature[] = defs.map((d) => {
      const override = overrideMap.has(d.feature_key)
        ? (overrideMap.get(d.feature_key) as boolean)
        : null;
      const enabled = override ?? d.default_enabled;
      const allowedPlanIds = planMap.get(d.feature_key) ?? [];
      const planIncluded = this.planIncluded(allowedPlanIds, currentPlanId, enforced);
      const directDeps = depMap.get(d.feature_key) ?? [];
      const depResult = this.resolveDeps(d.feature_key, depMap, base);

      const usage = this.usageLine(d.usage_metric, breakdown?.metrics);
      const quotaExceeded = enforced && !!usage?.exceeded;

      let available = true;
      let blockedReason: BlockedReason = null;
      if (!access.allowed) {
        available = false;
        blockedReason = 'subscription_inactive';
      } else if (!enabled) {
        available = false;
        blockedReason = 'disabled';
      } else if (!planIncluded) {
        available = false;
        blockedReason = 'plan_restricted';
      } else if (!depResult.satisfied) {
        available = false;
        blockedReason = 'dependency_missing';
      } else if (quotaExceeded) {
        available = false;
        blockedReason = 'quota_exceeded';
      }

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
        allowedPlanIds,
        planIncluded,
        dependencies: directDeps,
        missingDependencies: depResult.missing,
        dependenciesSatisfied: depResult.satisfied,
        usageMetric: d.usage_metric ?? null,
        usage,
        available,
        blockedReason,
      };
    });

    return {
      subscription: {
        active: access.allowed,
        enforced,
        status: subView?.effectiveStatus ?? this.sourceStatus(access.source),
        source: access.source,
        planId: currentPlanId,
        planName: breakdown?.planName ?? null,
        expiresAt: access.expiresAt ? new Date(access.expiresAt).toISOString() : null,
      },
      features,
    };
  }

  /** Direct + transitive dependency keys required by a feature. */
  async dependenciesOf(featureKey: string): Promise<string[]> {
    const deps = await this.dependencies.find();
    const depMap = new Map<string, string[]>();
    for (const d of deps) {
      depMap.set(d.feature_key, [...(depMap.get(d.feature_key) ?? []), d.requires_key]);
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

  private planIncluded(
    allowedPlanIds: string[],
    currentPlanId: string | null,
    enforced: boolean,
  ): boolean {
    if (allowedPlanIds.length === 0) return true; // available on all plans
    if (!enforced) return true; // free mode / override ignores plan gating
    if (!currentPlanId) return false; // enforced but plan unknown → restricted
    return allowedPlanIds.includes(currentPlanId);
  }

  private resolveDeps(
    key: string,
    depMap: Map<string, string[]>,
    base: Map<string, { enabled: boolean; planIncluded: boolean }>,
  ): { satisfied: boolean; missing: string[] } {
    const missing = new Set<string>();
    const walk = (k: string, seen: Set<string>): void => {
      for (const req of depMap.get(k) ?? []) {
        if (seen.has(req)) {
          this.logger.warn(`Circular feature dependency detected at "${req}"`);
          continue;
        }
        const b = base.get(req);
        if (!b || !b.enabled || !b.planIncluded) {
          missing.add(req);
        }
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

  private sourceStatus(source: string): string {
    if (source === 'PLATFORM_FREE_MODE') return 'FREE';
    if (source === 'FREE_OVERRIDE') return 'OVERRIDE';
    return 'NONE';
  }
}
