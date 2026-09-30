import type { SalesBonusType } from '../../entities/Sales/SalesTarget';

/** The bonus rule of a target, as stored / snapshotted. */
export interface SalesBonusRuleLike {
  type: SalesBonusType;
  thresholdPct: number | null;
  amount: number | null;
  percent: number | null;
  currency: string | null;
}

export interface ComputedBonus {
  /** The rule pays something at all (`type !== 'none'`). */
  applicable: boolean;
  /** The achievement threshold is met (`true` when the rule has none). */
  thresholdMet: boolean;
  /** What the rule pays for this achievement; 0 when not earned. */
  amount: number;
  /** The currency of `amount`; `null` when the rule pays nothing. */
  currency: string | null;
}

/** `numeric(8,2)` holds at most 999 999.99 — a wildly over-achieved tiny target must not overflow it. */
const PCT_CAP = 999_999.99;

const cents = (v: number): bigint => BigInt(Math.round(v * 100));

/**
 * Whether `achieved` reaches `thresholdPct` % of `target`, decided in integer
 * arithmetic. The rounded percentage shown in the UI cannot be used: 99 999.99
 * of 100 000.00 displays as 100 % yet has NOT reached a 100 % threshold.
 *
 * A target of 0 is trivially satisfied (progress reports 100 %, like the
 * clinic dashboard), so it meets any threshold up to 100.
 */
export function meetsThreshold(
  targetValue: number,
  achievedValue: number,
  thresholdPct: number,
): boolean {
  if (targetValue === 0) return thresholdPct <= 100;
  // achieved / target * 100 >= threshold, with every operand scaled to an integer:
  //   a/t * 100 >= h/100   <=>   a * 10 000 >= h * t     (a, t in cents; h in 1/100 %)
  return cents(achievedValue) * 10_000n >= cents(thresholdPct) * cents(targetValue);
}

/** `achieved * percent / 100`, rounded half-up to a cent, without float drift. */
function percentOf(achievedValue: number, percent: number): number {
  const scaled = cents(achievedValue) * cents(percent); // cents * (1/100 %)
  const roundedCents = (scaled * 2n + 10_000n) / 20_000n; // ÷ 10 000, half-up
  return Number(roundedCents) / 100;
}

/**
 * What a bonus rule pays for an achievement. PURE — the only place a bonus
 * amount is ever decided, and it runs on the server: the client never sends one.
 *
 *  - `none`                → nothing
 *  - `fixed_on_threshold`  → the fixed amount, once the threshold is met
 *  - `percent_of_achieved` → that share of the achieved revenue (in the target's
 *                            currency), once the threshold — if any — is met
 */
export function computeBonus(
  rule: SalesBonusRuleLike,
  targetValue: number,
  achievedValue: number,
): ComputedBonus {
  if (rule.type === 'none') {
    return { applicable: false, thresholdMet: false, amount: 0, currency: null };
  }
  const thresholdMet =
    rule.thresholdPct === null
      ? true
      : meetsThreshold(targetValue, achievedValue, rule.thresholdPct);

  let amount = 0;
  if (thresholdMet) {
    if (rule.type === 'fixed_on_threshold') {
      amount = rule.amount ?? 0;
    } else if (rule.type === 'percent_of_achieved') {
      amount = percentOf(achievedValue, rule.percent ?? 0);
    }
  }
  return { applicable: true, thresholdMet, amount, currency: rule.currency };
}

/** The achievement percentage as stored on a bonus record: 2 dp, capped to fit the column. */
export function storedAchievementPct(percentage: number | null): number {
  if (percentage === null || !Number.isFinite(percentage)) return 0;
  return Math.min(Math.max(percentage, 0), PCT_CAP);
}
