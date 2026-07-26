import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { AccessControlService } from './access-control.service';
import { TenantUsageLimitOverrideService } from './tenant-usage-limit-override.service';
import {
  CountLimitColumn,
  RESOURCE_LIMIT_MAP,
  ResourceMetric,
  USAGE_METRIC_MAP,
  UnifiedUsageLine,
  UsageMetric,
  currentPeriodMonth,
} from './usage-metric';

/**
 * Usage tracking per tenant per billing month.
 *
 * Tenant isolation: `subscription_usage` uses a plain `tenant_id` column (no
 * relation), so every query filters `where: { tenant_id: tenantId }`. The
 * `subscription_id` is resolved from the tenant's own subscription — never
 * trusted from input.
 */
@Injectable()
export class UsageService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionUsage)
    private readonly usage: Repository<SubscriptionUsage>,
    private readonly access: AccessControlService,
    private readonly limitOverrides: TenantUsageLimitOverrideService,
  ) {}

  /**
   * Atomically increments a usage metric for the tenant's current billing month.
   * Safe under concurrency: an idempotent upsert ensures the row exists, then a
   * single SQL `col = col + :amount` UPDATE performs the increment under a row
   * lock. Intended to be called from other domains (appointments, AI, …).
   */
  async increment(
    tenantId: string,
    metric: UsageMetric,
    amount = 1,
  ): Promise<void> {
    if (amount <= 0) return;
    // Free mode / active override → unmetered (no quota tracking).
    if (!(await this.access.isEnforced(tenantId))) return;
    const { usageColumn } = USAGE_METRIC_MAP[metric];
    // Best-effort: metering must NEVER break the operation it accompanies, so a
    // missing subscription (e.g. a worker/bot flow for an unsubscribed tenant)
    // is a silent no-op rather than a throw.
    const subscription = await this.findCurrentSubscription(tenantId);
    if (!subscription) return;
    const period = currentPeriodMonth();

    // 1) Ensure the (subscription, period) row exists — ON CONFLICT DO NOTHING.
    await this.usage
      .createQueryBuilder()
      .insert()
      .into(SubscriptionUsage)
      .values({
        tenant_id: tenantId,
        subscription_id: subscription.id,
        period_month: period,
        ai_tokens_used: '0',
        whatsapp_messages_used: 0,
        appointments_used: 0,
        campaigns_used: 0,
      })
      .orIgnore()
      .execute();

    // 2) Atomic increment.
    await this.usage
      .createQueryBuilder()
      .update(SubscriptionUsage)
      .set({
        [usageColumn]: () => `"${usageColumn}" + :amount`,
        updated_at: () => 'now()',
      })
      .where('subscription_id = :sid AND period_month = :pm', {
        sid: subscription.id,
        pm: period,
      })
      .setParameter('amount', amount)
      .execute();
  }

  /**
   * Throws (422) if incrementing `metric` by `amount` would exceed the plan
   * limit. A null/absent limit means unlimited. Use before `increment()` to
   * enforce a quota.
   */
  async assertWithinLimit(
    tenantId: string,
    metric: UsageMetric,
    amount = 1,
  ): Promise<void> {
    // Free platform mode or an active free-access override grant unmetered
    // access — plan quotas are not enforced against them.
    if (!(await this.access.isEnforced(tenantId))) return;

    const subscription = await this.resolveSubscription(tenantId, true);
    const { usageColumn, limitColumn } = USAGE_METRIC_MAP[metric];

    const limitRaw = (subscription.plan as unknown as Record<string, unknown>)[limitColumn];
    if (limitRaw === null || limitRaw === undefined) return; // unlimited

    // A paid, tenant-specific raise (billing-upgrade workflow) never LOWERS the
    // plan limit — the effective limit is the higher of the two.
    const override = await this.limitOverrides.getActive(tenantId, metric);
    const limit = override
      ? Math.max(Number(limitRaw), Number(override.override_limit))
      : Number(limitRaw);
    const row = await this.usage.findOne({
      where: {
        subscription_id: subscription.id,
        period_month: currentPeriodMonth(),
      },
    });
    const used = row ? Number((row as unknown as Record<string, unknown>)[usageColumn]) : 0;

    if (used + amount > limit) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Usage limit reached for ${metric} (${used}/${limit})`,
        publicContext: { metric, used, limit, requested: amount },
      });
    }
  }

  /**
   * Throws (422) when creating `amount` more of a COUNT-limited resource would
   * exceed the plan's absolute cap (e.g. max_branches, max_users). The caller
   * passes the CURRENT count from the resource's own repository; a null/absent
   * plan limit means unlimited. No-op under free mode / active override, matching
   * `assertWithinLimit` — so count limits behave identically to usage quotas.
   */
  async assertCountWithinLimit(
    tenantId: string,
    limitColumn: CountLimitColumn,
    currentCount: number,
    amount = 1,
  ): Promise<void> {
    if (!(await this.access.isEnforced(tenantId))) return;

    const subscription = await this.resolveSubscription(tenantId, true);
    const limitRaw = (subscription.plan as unknown as Record<string, unknown>)[
      limitColumn
    ];
    if (limitRaw === null || limitRaw === undefined) return; // unlimited

    const limit = Number(limitRaw);
    if (currentCount + amount > limit) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Plan limit reached for ${limitColumn} (${currentCount}/${limit})`,
        publicContext: { limit: limitColumn, current: currentCount, max: limit, requested: amount },
      });
    }
  }

  /**
   * Average per-period usage for a metered metric over the last N periods
   * (null when the tenant has no subscription or no usage history yet). Pure
   * aggregate number — feeds the billing-upgrade AI cost estimate's
   * "historical aggregate consumption" input without exposing any raw
   * tenant/customer content.
   */
  async getHistoricalAverage(
    tenantId: string,
    metric: UsageMetric,
    periods = 3,
  ): Promise<number | null> {
    const subscription = await this.findCurrentSubscription(tenantId);
    if (!subscription) return null;
    const { usageColumn } = USAGE_METRIC_MAP[metric];
    const rows = await this.usage.find({
      where: { subscription_id: subscription.id },
      order: { period_month: 'DESC' },
      take: periods,
    });
    if (rows.length === 0) return null;
    const total = rows.reduce(
      (sum, r) => sum + Number((r as unknown as Record<string, unknown>)[usageColumn]),
      0,
    );
    return total / rows.length;
  }

  /** Raw usage row for a period (zeros if none yet). */
  async getUsage(tenantId: string, periodMonth?: string) {
    const subscription = await this.resolveSubscription(tenantId);
    const period = periodMonth ?? currentPeriodMonth();

    const row = await this.usage.findOne({
      where: { tenant_id: tenantId, subscription_id: subscription.id, period_month: period },
    });

    return {
      tenantId,
      subscriptionId: subscription.id,
      periodMonth: period,
      aiTokensUsed: row ? Number(row.ai_tokens_used) : 0,
      whatsappMessagesUsed: row?.whatsapp_messages_used ?? 0,
      appointmentsUsed: row?.appointments_used ?? 0,
      campaignsUsed: row?.campaigns_used ?? 0,
      updatedAt: row?.updated_at ?? null,
    };
  }

  /** Usage vs plan limits, with remaining + percentage per metric. */
  async getBreakdown(tenantId: string, periodMonth?: string) {
    const subscription = await this.resolveSubscription(tenantId, true);
    const usage = await this.getUsage(tenantId, periodMonth);
    const plan = subscription.plan as unknown as Record<string, unknown>;
    const overrides = await this.limitOverrides.getActiveMap(tenantId);

    // Public shape is unchanged — the historical 5 fields, derived from the same
    // single line formula used everywhere (buildLine).
    const line = (used: number, limitRaw: unknown, metric: string) => {
      const l = this.buildLine(used, this.mergeLimit(limitRaw, overrides.get(metric)));
      return { used: l.used, limit: l.limit, remaining: l.remaining, percentUsed: l.percentUsed, exceeded: l.exceeded };
    };

    return {
      tenantId,
      periodMonth: usage.periodMonth,
      planId: subscription.plan.id,
      planName: subscription.plan.name,
      metrics: {
        aiTokens: line(usage.aiTokensUsed, plan.max_ai_tokens, 'AI_TOKENS'),
        whatsappMessages: line(usage.whatsappMessagesUsed, plan.max_whatsapp_messages, 'WHATSAPP_MESSAGES'),
        appointments: line(usage.appointmentsUsed, plan.max_appointments, 'APPOINTMENTS'),
        campaigns: line(usage.campaignsUsed, plan.max_campaigns, 'CAMPAIGNS'),
      },
    };
  }

  /**
   * The SINGLE authoritative breakdown for EVERY metric (metered + count-based).
   *
   * Resolves the tenant's subscription + plan ONCE, reads the metered usage row
   * ONCE, and checks enforcement ONCE, then produces a uniform
   * {used,limit,remaining,percentUsed,exceeded,unlimited,blocked} line per metric.
   * Metered metrics read `subscription_usage`; count-based metrics use the LIVE
   * `counts` supplied by the caller (whose own repositories own those tables)
   * combined with the plan limit resolved via `RESOURCE_LIMIT_MAP`. Every limit
   * therefore still comes from `SubscriptionPlan` — this method never hardcodes
   * one. Non-throwing: a tenant with no subscription yields all-unlimited lines
   * with `used` from the live counts.
   */
  async getUnifiedBreakdown(
    tenantId: string,
    counts: Partial<Record<ResourceMetric, number>> = {},
    periodMonth?: string,
  ): Promise<Record<string, UnifiedUsageLine>> {
    const enforced = await this.access.isEnforced(tenantId).catch(() => true);
    const subscription = await this.findCurrentSubscriptionWithPlan(tenantId);
    const plan = subscription?.plan as unknown as Record<string, unknown> | undefined;
    const period = periodMonth ?? currentPeriodMonth();
    const usageRow = subscription
      ? await this.usage.findOne({ where: { subscription_id: subscription.id, period_month: period } })
      : null;
    const overrides = await this.limitOverrides.getActiveMap(tenantId);
    const uv = (col: string): number =>
      usageRow ? Number((usageRow as unknown as Record<string, unknown>)[col]) : 0;

    const out: Record<string, UnifiedUsageLine> = {
      aiTokens: this.buildLine(uv('ai_tokens_used'), this.mergeLimit(plan?.max_ai_tokens, overrides.get('AI_TOKENS')), enforced),
      whatsappMessages: this.buildLine(uv('whatsapp_messages_used'), this.mergeLimit(plan?.max_whatsapp_messages, overrides.get('WHATSAPP_MESSAGES')), enforced),
      appointments: this.buildLine(uv('appointments_used'), this.mergeLimit(plan?.max_appointments, overrides.get('APPOINTMENTS')), enforced),
      campaigns: this.buildLine(uv('campaigns_used'), this.mergeLimit(plan?.max_campaigns, overrides.get('CAMPAIGNS')), enforced),
    };
    for (const [metric, col] of Object.entries(RESOURCE_LIMIT_MAP)) {
      out[metric] = this.buildLine(
        counts[metric as ResourceMetric] ?? 0,
        this.mergeLimit(plan?.[col], overrides.get(metric)),
        enforced,
      );
    }
    return out;
  }

  /**
   * Raises `planRaw` to an active tenant override's limit, never below it and
   * never disturbing an unlimited (null) plan limit. A no-op when no override
   * exists for the metric — existing callers/tests are unaffected.
   */
  private mergeLimit(planRaw: unknown, overrideLimit: number | undefined): unknown {
    if (planRaw === null || planRaw === undefined) return planRaw;
    if (overrideLimit === undefined) return planRaw;
    return Math.max(Number(planRaw), overrideLimit);
  }

  /** The one line formula — used by getBreakdown and getUnifiedBreakdown. */
  private buildLine(used: number, limitRaw: unknown, enforced = false): UnifiedUsageLine {
    const limit = limitRaw === null || limitRaw === undefined ? null : Number(limitRaw);
    const exceeded = limit === null ? false : used > limit;
    return {
      used,
      limit,
      remaining: limit === null ? null : Math.max(limit - used, 0),
      percentUsed: limit === null || limit === 0 ? null : +((used / limit) * 100).toFixed(1),
      exceeded,
      unlimited: limit === null,
      blocked: exceeded && enforced,
    };
  }

  /** Non-throwing current subscription WITH plan (for the unified breakdown). */
  private findCurrentSubscriptionWithPlan(tenantId: string): Promise<Subscription | null> {
    return this.subscriptions.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
      relations: { plan: true },
      order: { created_at: 'DESC' },
    });
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** The tenant's non-cancelled subscription (optionally with the plan loaded). */
  private async resolveSubscription(
    tenantId: string,
    withPlan = false,
  ): Promise<Subscription> {
    const subscription = await this.subscriptions.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
      relations: withPlan ? { plan: true } : {},
      order: { created_at: 'DESC' },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No active subscription found for this tenant',
      });
    }
    return subscription;
  }

  /** Non-throwing variant for best-effort metering (returns null when none). */
  private findCurrentSubscription(tenantId: string): Promise<Subscription | null> {
    return this.subscriptions.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
      order: { created_at: 'DESC' },
    });
  }
}
