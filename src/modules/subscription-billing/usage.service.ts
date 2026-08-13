import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Not, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { AccessControlService } from './access-control.service';
import { TenantUsageLimitOverrideService } from './tenant-usage-limit-override.service';
import { COUNT_LIMIT_FEATURE, featuresForMetric } from './feature-registry';
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
    // Free mode / free-access override / per-feature override → unmetered.
    if (
      !(await this.access.isEnforced(
        tenantId,
        undefined,
        featuresForMetric(metric),
      ))
    ) {
      return;
    }
    await this.applyDelta(this.usage, tenantId, metric, amount, 'add');
  }

  /**
   * FND-034 — releases a reservation taken by `incrementIfWithinLimit` when
   * the operation it was reserved for did not actually happen (e.g. a
   * WhatsApp/AI provider call failed after admission). NOT `increment()`
   * with a negative amount — `increment()` guards `amount <= 0` as a no-op,
   * by design, for its own (always-positive) callers. Clamps at zero
   * (`GREATEST`) so a duplicate/late release can never drive usage negative.
   */
  async release(
    tenantId: string,
    metric: UsageMetric,
    amount = 1,
  ): Promise<void> {
    if (amount <= 0) return;
    await this.applyDelta(this.usage, tenantId, metric, amount, 'subtract');
  }

  /**
   * FND-034 — atomic check-and-increment. Replaces the `assertWithinLimit`
   * (read) then, later, `increment()` (write) PAIR at a call site: that gap
   * is a check-then-act race — two concurrent callers can both read
   * "under limit" before either has incremented, admitting both. This folds
   * the boundary check into the SAME `UPDATE`'s `WHERE` clause as the
   * increment, so Postgres's own per-row lock is the arbiter: a second
   * concurrent UPDATE against the same row blocks until the first commits,
   * then re-evaluates the WHERE clause against the NEW value.
   *
   * Returns `{applied, used, limit}` rather than throwing — the call site
   * decides how to react (e.g. throw its existing 422, or release/roll back
   * whatever else it was about to do). `used`/`limit` are populated only
   * when `applied` is false (a follow-up read, purely for the error
   * message — not itself part of the atomic decision).
   *
   * Pass `manager` to run inside a caller's own transaction — e.g. so a
   * later rollback (a downstream failure) undoes the increment too. Without
   * one, the increment commits on its own as soon as this call returns; a
   * caller on that path that can't wrap a DB transaction around the rest of
   * its work (e.g. an external provider call) must explicitly call
   * `increment(tenantId, metric, -1)` to release the reservation on failure.
   *
   * Free mode / an active override / an unlimited (null) plan limit are
   * unmetered, exactly like `assertWithinLimit` — always `applied: true`.
   */
  async incrementIfWithinLimit(
    tenantId: string,
    metric: UsageMetric,
    amount = 1,
    manager?: EntityManager,
  ): Promise<{ applied: boolean; used: number; limit: number | null }> {
    const repo = manager
      ? manager.getRepository(SubscriptionUsage)
      : this.usage;

    if (
      !(await this.access.isEnforced(
        tenantId,
        manager,
        featuresForMetric(metric),
      ))
    ) {
      await this.rawIncrement(repo, tenantId, metric, amount, manager);
      return { applied: true, used: 0, limit: null };
    }

    const subscription = await this.resolveSubscription(
      tenantId,
      true,
      manager,
    );
    const { usageColumn, limitColumn } = USAGE_METRIC_MAP[metric];
    const limitRaw = (subscription.plan as unknown as Record<string, unknown>)[
      limitColumn
    ];
    if (limitRaw === null || limitRaw === undefined) {
      await this.rawIncrement(repo, tenantId, metric, amount, manager);
      return { applied: true, used: 0, limit: null }; // unlimited
    }

    const override = await this.limitOverrides.getActive(
      tenantId,
      metric,
      manager,
    );
    const limit = override
      ? Math.max(Number(limitRaw), Number(override.override_limit))
      : Number(limitRaw);
    const period = currentPeriodMonth();

    // Ensure the (subscription, period) row exists first — same idempotent
    // upsert `increment()` uses. Harmless under concurrency (ON CONFLICT DO
    // NOTHING); the atomic decision happens in the UPDATE below, not here.
    await repo
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

    const result = await repo
      .createQueryBuilder()
      .update(SubscriptionUsage)
      .set({
        [usageColumn]: () => `"${usageColumn}" + :amount`,
        updated_at: () => 'now()',
      })
      .where(
        `subscription_id = :sid AND period_month = :pm AND "${usageColumn}" + :amount <= :limit`,
        { sid: subscription.id, pm: period, amount, limit },
      )
      .execute();

    const applied = (result.affected ?? 0) > 0;
    if (applied) return { applied: true, used: 0, limit };

    // Not applied — a fresh read purely to report the current value; no
    // decision is made from it (the UPDATE above already made the decision
    // atomically), so a race between this read and another writer cannot
    // reintroduce the bug — it can only make the reported `used` figure
    // slightly stale by the time the caller logs/returns it.
    const row = await repo.findOne({
      where: { subscription_id: subscription.id, period_month: period },
    });
    const used = row
      ? Number((row as unknown as Record<string, unknown>)[usageColumn])
      : 0;
    return { applied: false, used, limit };
  }

  /** Shared increment body, repo-parametrized so `incrementIfWithinLimit` can target a caller's manager. */
  private async rawIncrement(
    repo: Repository<SubscriptionUsage>,
    tenantId: string,
    metric: UsageMetric,
    amount: number,
    manager?: EntityManager,
  ): Promise<void> {
    await this.applyDelta(repo, tenantId, metric, amount, 'add', manager);
  }

  /**
   * The one place a usage counter moves.
   *
   * Records against the tenant's subscription when it has one, and against a
   * subscription-less row for the tenant-month when it does not. That second
   * case is the point: a clinic running on a super-admin feature grant has no
   * plan and therefore no cap, but its consumption still has to be visible —
   * previously these calls simply returned early and the platform recorded
   * nothing at all for those tenants.
   */
  private async applyDelta(
    repo: Repository<SubscriptionUsage>,
    tenantId: string,
    metric: UsageMetric,
    amount: number,
    direction: 'add' | 'subtract',
    manager?: EntityManager,
  ): Promise<void> {
    const subscription = await this.findCurrentSubscription(tenantId, manager);
    const scope = this.scopeOf(tenantId, subscription?.id ?? null);
    const { usageColumn } = USAGE_METRIC_MAP[metric];

    // Idempotent upsert: harmless under concurrency (ON CONFLICT DO NOTHING),
    // and covered by the partial unique index on the subscription-less path.
    await repo
      .createQueryBuilder()
      .insert()
      .into(SubscriptionUsage)
      .values({
        tenant_id: tenantId,
        subscription_id: scope.subscriptionId,
        period_month: scope.period,
        ai_tokens_used: '0',
        whatsapp_messages_used: 0,
        appointments_used: 0,
        campaigns_used: 0,
      })
      .orIgnore()
      .execute();

    const expression =
      direction === 'add'
        ? `"${usageColumn}" + :amount`
        : // Clamp at zero so a duplicate or late release cannot drive a
          // counter negative.
          `GREATEST("${usageColumn}" - :amount, 0)`;

    await repo
      .createQueryBuilder()
      .update(SubscriptionUsage)
      .set({
        [usageColumn]: () => expression,
        updated_at: () => 'now()',
      })
      .where(scope.where, scope.params)
      .setParameter('amount', amount)
      .execute();
  }

  /**
   * Identifies the usage row for a tenant-month.
   *
   * Subscribed tenants key on `subscription_id` (the historical unique
   * constraint). Subscription-less tenants key on `(tenant_id, period_month)`
   * with `subscription_id IS NULL`, which the partial unique index keeps to one
   * row — plain `subscription_id = NULL` would never match anything, and the
   * default unique constraint treats NULLs as distinct.
   */
  private scopeOf(
    tenantId: string,
    subscriptionId: string | null,
    periodMonth?: string,
  ): {
    subscriptionId: string | null;
    period: string;
    where: string;
    params: Record<string, unknown>;
  } {
    const period = periodMonth ?? currentPeriodMonth();
    return subscriptionId
      ? {
          subscriptionId,
          period,
          where: 'subscription_id = :sid AND period_month = :pm',
          params: { sid: subscriptionId, pm: period },
        }
      : {
          subscriptionId: null,
          period,
          where:
            'tenant_id = :tid AND period_month = :pm AND subscription_id IS NULL',
          params: { tid: tenantId, pm: period },
        };
  }

  /** TypeORM `findOne` shape matching {@link scopeOf}. */
  private rowFilter(
    tenantId: string,
    subscriptionId: string | null,
    period: string,
  ) {
    return subscriptionId
      ? { subscription_id: subscriptionId, period_month: period }
      : {
          tenant_id: tenantId,
          subscription_id: IsNull(),
          period_month: period,
        };
  }

  /**
   * Throws (422) if incrementing `metric` by `amount` would exceed the plan
   * limit. A null/absent limit means unlimited. Use before `increment()` to
   * enforce a quota.
   *
   * Superseded by `incrementIfWithinLimit` at the 4 call sites that need
   * concurrency-safety (FND-034) — kept here for any read-only/preview use
   * that wants a plain assertion without also mutating usage.
   */
  async assertWithinLimit(
    tenantId: string,
    metric: UsageMetric,
    amount = 1,
  ): Promise<void> {
    // Free platform mode, a free-access override, or a per-feature override
    // grant unmetered access — plan quotas are not enforced against them.
    if (
      !(await this.access.isEnforced(
        tenantId,
        undefined,
        featuresForMetric(metric),
      ))
    ) {
      return;
    }

    const subscription = await this.resolveSubscription(tenantId, true);
    const { usageColumn, limitColumn } = USAGE_METRIC_MAP[metric];

    const limitRaw = (subscription.plan as unknown as Record<string, unknown>)[
      limitColumn
    ];
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
    const used = row
      ? Number((row as unknown as Record<string, unknown>)[usageColumn])
      : 0;

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
    // Scoped by the capability this cap belongs to, exactly like the metered
    // paths. Asking the UNSCOPED question here is what made branch creation
    // and staff invites fail with a bare 404 for a tenant running on a
    // super-admin grant: enforcement was reported as on, and the next line
    // then demanded a subscription that by design does not exist.
    if (
      !(await this.access.isEnforced(tenantId, undefined, [
        COUNT_LIMIT_FEATURE[limitColumn],
      ]))
    ) {
      return;
    }

    const subscription = await this.findCurrentSubscriptionWithPlan(tenantId);
    if (!subscription) return; // enforced but no plan to compare against
    const limitRaw = (subscription.plan as unknown as Record<string, unknown>)[
      limitColumn
    ];
    if (limitRaw === null || limitRaw === undefined) return; // unlimited

    const limit = Number(limitRaw);
    if (currentCount + amount > limit) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Plan limit reached for ${limitColumn} (${currentCount}/${limit})`,
        publicContext: {
          limit: limitColumn,
          current: currentCount,
          max: limit,
          requested: amount,
        },
      });
    }
  }

  /**
   * FND-007 — atomic seat-cap (`max_users`) check-and-admit. Unlike the
   * metered metrics above, there is no accumulator column for a live
   * COUNT-based cap — `assertCountWithinLimit` reads a caller-supplied count
   * that was fetched BEFORE this call, which is exactly the check-then-act
   * gap: two concurrent callers can both count N, both see room for one
   * more, and both insert. Fixed here by locking the TENANT row (a natural
   * per-tenant mutex) for the remainder of `manager`'s transaction — a
   * second concurrent call blocks on that lock until the first commits (or
   * rolls back), then re-counts and sees the TRUE post-insert total. Must be
   * called INSIDE the same transaction as the user INSERT it is guarding,
   * with the insert placed AFTER this returns.
   *
   * Seat additions are a rare, low-frequency admin action (not a hot metered
   * path), so the row lock's serialization cost — the concern AD-10 raised
   * against `SELECT … FOR UPDATE` for the high-frequency quota metrics — does
   * not apply here.
   */
  async assertUserSeatWithinLimit(
    tenantId: string,
    manager: EntityManager,
    amount = 1,
  ): Promise<void> {
    if (
      !(await this.access.isEnforced(tenantId, manager, [
        COUNT_LIMIT_FEATURE.max_users,
      ]))
    ) {
      return;
    }

    await manager.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [
      tenantId,
    ]);

    const subscription = await manager.getRepository(Subscription).findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
      relations: { plan: true },
      order: { created_at: 'DESC' },
    });
    // No plan means no seat cap to enforce. This used to throw a bare 404
    // ("No active subscription found for this tenant"), which surfaced to an
    // operator inviting staff as a confusing not-found rather than anything to
    // do with billing — and blocked tenants the platform had deliberately
    // granted access to.
    if (!subscription) return;
    const limitRaw = (subscription.plan as unknown as Record<string, unknown>)
      .max_users;
    if (limitRaw === null || limitRaw === undefined) return; // unlimited

    const limit = Number(limitRaw);
    const currentUsers = await manager
      .getRepository(User)
      .count({ where: { tenant: { id: tenantId } as Tenant } });
    if (currentUsers + amount > limit) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Plan limit reached for max_users (${currentUsers}/${limit})`,
        publicContext: {
          limit: 'max_users',
          current: currentUsers,
          max: limit,
          requested: amount,
        },
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
      (sum, r) =>
        sum + Number((r as unknown as Record<string, unknown>)[usageColumn]),
      0,
    );
    return total / rows.length;
  }

  /** Raw usage row for a period (zeros if none yet). */
  async getUsage(tenantId: string, periodMonth?: string) {
    // Non-throwing: a tenant on a super-admin grant has no subscription but
    // does have recorded usage, and reporting its own consumption back to it
    // must not 404.
    const subscription = await this.findCurrentSubscription(tenantId);
    const period = periodMonth ?? currentPeriodMonth();

    const row = await this.usage.findOne({
      where: this.rowFilter(tenantId, subscription?.id ?? null, period),
    });

    return {
      tenantId,
      subscriptionId: subscription?.id ?? null,
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
    // Non-throwing. This used to `resolveSubscription(…)` and 404 for any
    // tenant without one, which made `GET /usage/breakdown`, the AI
    // GET_USAGE_QUOTA tool and the billing-upgrade estimate all fail for
    // clinics running on a super-admin grant — tenants whose usage the
    // platform now records precisely so it can be reported.
    const subscription = await this.findCurrentSubscriptionWithPlan(tenantId);
    const usage = await this.getUsage(tenantId, periodMonth);
    const plan = (subscription?.plan ?? {}) as unknown as Record<
      string,
      unknown
    >;
    const overrides = await this.limitOverrides.getActiveMap(tenantId);

    // Public shape is unchanged — the historical 5 fields, derived from the same
    // single line formula used everywhere (buildLine).
    const line = (used: number, limitRaw: unknown, metric: string) => {
      const l = this.buildLine(
        used,
        this.mergeLimit(limitRaw, overrides.get(metric)),
      );
      return {
        used: l.used,
        limit: l.limit,
        remaining: l.remaining,
        percentUsed: l.percentUsed,
        exceeded: l.exceeded,
      };
    };

    return {
      tenantId,
      periodMonth: usage.periodMonth,
      planId: subscription?.plan?.id ?? null,
      planName: subscription?.plan?.name ?? null,
      metrics: {
        aiTokens: line(usage.aiTokensUsed, plan.max_ai_tokens, 'AI_TOKENS'),
        whatsappMessages: line(
          usage.whatsappMessagesUsed,
          plan.max_whatsapp_messages,
          'WHATSAPP_MESSAGES',
        ),
        appointments: line(
          usage.appointmentsUsed,
          plan.max_appointments,
          'APPOINTMENTS',
        ),
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
    const plan = subscription?.plan as unknown as
      | Record<string, unknown>
      | undefined;
    const period = periodMonth ?? currentPeriodMonth();
    // Reads the subscription-less row too, so an override tenant's consumption
    // shows up here rather than reporting a flat zero.
    const usageRow = await this.usage.findOne({
      where: this.rowFilter(tenantId, subscription?.id ?? null, period),
    });
    const overrides = await this.limitOverrides.getActiveMap(tenantId);
    const uv = (col: string): number =>
      usageRow
        ? Number((usageRow as unknown as Record<string, unknown>)[col])
        : 0;

    const out: Record<string, UnifiedUsageLine> = {
      aiTokens: this.buildLine(
        uv('ai_tokens_used'),
        this.mergeLimit(plan?.max_ai_tokens, overrides.get('AI_TOKENS')),
        enforced,
      ),
      whatsappMessages: this.buildLine(
        uv('whatsapp_messages_used'),
        this.mergeLimit(
          plan?.max_whatsapp_messages,
          overrides.get('WHATSAPP_MESSAGES'),
        ),
        enforced,
      ),
      appointments: this.buildLine(
        uv('appointments_used'),
        this.mergeLimit(plan?.max_appointments, overrides.get('APPOINTMENTS')),
        enforced,
      ),
      campaigns: this.buildLine(
        uv('campaigns_used'),
        this.mergeLimit(plan?.max_campaigns, overrides.get('CAMPAIGNS')),
        enforced,
      ),
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
  private mergeLimit(
    planRaw: unknown,
    overrideLimit: number | undefined,
  ): unknown {
    if (planRaw === null || planRaw === undefined) return planRaw;
    if (overrideLimit === undefined) return planRaw;
    return Math.max(Number(planRaw), overrideLimit);
  }

  /** The one line formula — used by getBreakdown and getUnifiedBreakdown. */
  private buildLine(
    used: number,
    limitRaw: unknown,
    enforced = false,
  ): UnifiedUsageLine {
    const limit =
      limitRaw === null || limitRaw === undefined ? null : Number(limitRaw);
    const exceeded = limit === null ? false : used > limit;
    return {
      used,
      limit,
      remaining: limit === null ? null : Math.max(limit - used, 0),
      percentUsed:
        limit === null || limit === 0
          ? null
          : +((used / limit) * 100).toFixed(1),
      exceeded,
      unlimited: limit === null,
      blocked: exceeded && enforced,
    };
  }

  /** Non-throwing current subscription WITH plan (for the unified breakdown). */
  private findCurrentSubscriptionWithPlan(
    tenantId: string,
  ): Promise<Subscription | null> {
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

  /**
   * The tenant's non-cancelled subscription (optionally with the plan loaded).
   *
   * FND-047: pass the caller's `manager` when reached from inside an open
   * `dataSource.transaction()` (`incrementIfWithinLimit`'s campaign/appointment
   * call sites) — this read must reuse that transaction's own connection, not
   * borrow a second one from the pool.
   */
  private async resolveSubscription(
    tenantId: string,
    withPlan = false,
    manager?: EntityManager,
  ): Promise<Subscription> {
    const repo = manager
      ? manager.getRepository(Subscription)
      : this.subscriptions;
    const subscription = await repo.findOne({
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

  /** Non-throwing variant for best-effort metering (returns null when none). Same FND-047 manager-threading rule as `resolveSubscription`. */
  private findCurrentSubscription(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Subscription | null> {
    const repo = manager
      ? manager.getRepository(Subscription)
      : this.subscriptions;
    return repo.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
      order: { created_at: 'DESC' },
    });
  }
}
