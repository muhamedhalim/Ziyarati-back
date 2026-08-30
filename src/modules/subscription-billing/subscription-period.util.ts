import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { BillingCycle, CustomCycleUnit } from '../../entities/enums';

/**
 * Spec 014 (Clinic Platform Completion) — T080 (US5, FR-B003). Extracted
 * from `SubscriptionService`'s own (previously private) `computeEnds` —
 * MONTHLY/YEARLY/CUSTOM cycle arithmetic, unchanged, so `RenewalService`'s
 * period-N+1 boundary and `SubscriptionService`'s trial→paid/plan-change
 * boundary are computed by the exact same rule. Two independent
 * implementations of "add one billing cycle" is exactly how periods end up
 * with a gap or an overlap between them.
 *
 * UTC month/year arithmetic (`setUTCMonth`/`setUTCFullYear`) rather than
 * fixed-day-count math, so a monthly cycle starting on the 31st correctly
 * rolls to the last day of a shorter month instead of drifting.
 */
export function computeNextPeriodEnd(
  start: Date,
  plan: SubscriptionPlan,
): Date {
  const end = new Date(start);
  switch (plan.billing_cycle) {
    case BillingCycle.YEARLY:
      end.setUTCFullYear(end.getUTCFullYear() + 1);
      break;
    case BillingCycle.CUSTOM: {
      // Both columns are required together at the DTO level; a plan with
      // billing_cycle CUSTOM but no duration is malformed data, not a
      // normal case — fall back to monthly rather than a no-op end date.
      const value = plan.custom_cycle_value ?? 1;
      switch (plan.custom_cycle_unit) {
        case CustomCycleUnit.DAY:
          end.setUTCDate(end.getUTCDate() + value);
          break;
        case CustomCycleUnit.YEAR:
          end.setUTCFullYear(end.getUTCFullYear() + value);
          break;
        case CustomCycleUnit.MONTH:
        default:
          end.setUTCMonth(end.getUTCMonth() + value);
          break;
      }
      break;
    }
    case BillingCycle.MONTHLY:
    default:
      end.setUTCMonth(end.getUTCMonth() + 1);
      break;
  }
  return end;
}
