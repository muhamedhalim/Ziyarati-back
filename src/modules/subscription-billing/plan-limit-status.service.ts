import { Injectable } from '@nestjs/common';

import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { PLAN_LIMIT_FIELDS } from './plan-admin.service';

/**
 * The three-state plan-limit model (Phase 0.2, plan §8).
 *
 * A `NULL` plan limit column has meant "unlimited" at ~20 call sites since
 * the plan was written, and the admin UI rendered `∞` into an empty input —
 * indistinguishable from a column nobody has configured yet. This resolves
 * every limit column to exactly one of three states, reusing
 * {@link PLAN_LIMIT_FIELDS} (Phase 0.1's single source of truth for "what
 * are the 19 limit columns") rather than a second hand-maintained list.
 */
export const PLAN_LIMIT_STATUS = {
  FINITE: 'finite',
  UNLIMITED: 'unlimited',
  NOT_CONFIGURED: 'not_configured',
} as const;
export type PlanLimitStatus = (typeof PLAN_LIMIT_STATUS)[keyof typeof PLAN_LIMIT_STATUS];

export type PlanLimitColumn = (typeof PLAN_LIMIT_FIELDS)[number]['column'];

@Injectable()
export class PlanLimitStatusService {
  /**
   * - a number is set → **Finite** (sellable as an add-on target).
   * - `NULL` and declared `"unlimited"` in `limit_declarations` → **Unlimited (by design)**.
   * - `NULL` and not declared → **Not configured** — the warning state.
   */
  resolve(plan: SubscriptionPlan, column: PlanLimitColumn): PlanLimitStatus {
    const raw = (plan as unknown as Record<string, unknown>)[column];
    if (raw !== null && raw !== undefined) return PLAN_LIMIT_STATUS.FINITE;
    const declared = plan.limit_declarations?.[column];
    return declared === 'unlimited'
      ? PLAN_LIMIT_STATUS.UNLIMITED
      : PLAN_LIMIT_STATUS.NOT_CONFIGURED;
  }

  /** Every limit column's status, keyed by column name. */
  resolveAll(plan: SubscriptionPlan): Record<PlanLimitColumn, PlanLimitStatus> {
    const out = {} as Record<PlanLimitColumn, PlanLimitStatus>;
    for (const field of PLAN_LIMIT_FIELDS) {
      out[field.column] = this.resolve(plan, field.column);
    }
    return out;
  }

  /** True when at least one of `columns` is genuinely Finite on this plan. */
  hasAnyFiniteLimit(plan: SubscriptionPlan, columns: PlanLimitColumn[]): boolean {
    return columns.some((c) => this.resolve(plan, c) === PLAN_LIMIT_STATUS.FINITE);
  }

  /**
   * Coverage summary across a set of active plans for ONE column — the
   * "Finite on 2 of 5 active plans · 1 unlimited · 2 not configured" badge
   * the catalog's publish gate (Phase 2.1) reports. `plans` should already
   * be filtered to `is_active`; this method does not filter itself so a
   * caller can also run it against the full catalogue if needed.
   */
  coverage(
    plans: SubscriptionPlan[],
    column: PlanLimitColumn,
  ): { finite: number; unlimited: number; notConfigured: number; total: number } {
    let finite = 0;
    let unlimited = 0;
    let notConfigured = 0;
    for (const plan of plans) {
      const status = this.resolve(plan, column);
      if (status === PLAN_LIMIT_STATUS.FINITE) finite++;
      else if (status === PLAN_LIMIT_STATUS.UNLIMITED) unlimited++;
      else notConfigured++;
    }
    return { finite, unlimited, notConfigured, total: plans.length };
  }
}
