import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import {
  USAGE_METRIC_MAP,
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
    const { usageColumn } = USAGE_METRIC_MAP[metric];
    const subscription = await this.resolveSubscription(tenantId);
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
    const subscription = await this.resolveSubscription(tenantId, true);
    const { usageColumn, limitColumn } = USAGE_METRIC_MAP[metric];

    const limitRaw = (subscription.plan as unknown as Record<string, unknown>)[limitColumn];
    if (limitRaw === null || limitRaw === undefined) return; // unlimited

    const limit = Number(limitRaw);
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
        context: { metric, used, limit, requested: amount },
      });
    }
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

    const line = (used: number, limitRaw: unknown) => {
      const limit = limitRaw === null || limitRaw === undefined ? null : Number(limitRaw);
      return {
        used,
        limit,
        remaining: limit === null ? null : Math.max(limit - used, 0),
        percentUsed: limit === null || limit === 0 ? null : +((used / limit) * 100).toFixed(1),
        exceeded: limit === null ? false : used > limit,
      };
    };

    return {
      tenantId,
      periodMonth: usage.periodMonth,
      planId: subscription.plan.id,
      planName: subscription.plan.name,
      metrics: {
        aiTokens: line(usage.aiTokensUsed, plan.max_ai_tokens),
        whatsappMessages: line(usage.whatsappMessagesUsed, plan.max_whatsapp_messages),
        appointments: line(usage.appointmentsUsed, plan.max_appointments),
        campaigns: line(usage.campaignsUsed, plan.max_campaigns),
      },
    };
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
}
