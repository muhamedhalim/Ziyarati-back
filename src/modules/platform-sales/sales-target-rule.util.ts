import { AppError, ErrorCode } from '../../common/errors';
import { SALES_BONUS_TYPE } from '../../entities/Sales/SalesTarget';
import type {
  SalesBonusType,
  SalesMetric,
} from '../../entities/Sales/SalesTarget';
import {
  SALES_AMOUNT_MAX,
  SALES_THRESHOLD_PCT_MAX,
} from './platform-sales.constants';

/** What the admin typed, before validation. Every field is optional. */
export interface SalesTargetRuleInput {
  targetValue: number;
  currency?: string | null;
  bonusType?: SalesBonusType | null;
  bonusThresholdPct?: number | null;
  bonusAmount?: number | null;
  bonusPercent?: number | null;
  bonusCurrency?: string | null;
}

/** A target + bonus rule after validation and defaulting — exactly what is stored. */
export interface SalesTargetRule {
  targetValue: number;
  currency: string | null;
  bonusType: SalesBonusType;
  bonusThresholdPct: number | null;
  bonusAmount: number | null;
  bonusPercent: number | null;
  bonusCurrency: string | null;
}

const fail = (field: string, message: string): never => {
  throw new AppError(ErrorCode.VALIDATION_ERROR, {
    message,
    publicContext: { field },
  });
};

const present = (v: unknown): boolean => v !== undefined && v !== null;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Validates a target and its bonus rule and fills in the defaults, so the
 * database CHECK constraints (`CHK_sales_targets_currency`, `..._bonus_shape`)
 * are never the thing that reports a mistake — they would surface as a 500.
 *
 * Pure: `defaultCurrency` and `allowedCurrencies` are passed in.
 */
export function normalizeSalesTargetRule(
  metric: SalesMetric,
  input: SalesTargetRuleInput,
  defaultCurrency: string,
  allowedCurrencies: readonly string[],
): SalesTargetRule {
  const isRevenue = metric === 'subscription_revenue';

  const value = input.targetValue;
  if (!Number.isFinite(value) || value < 0 || value > SALES_AMOUNT_MAX) {
    fail('targetValue', 'targetValue must be a number of 0 or more');
  }
  if (!isRevenue && !Number.isInteger(value)) {
    fail('targetValue', 'A clinic or conversion target must be a whole number');
  }
  const targetValue = round2(value);

  const checkCurrency = (field: string, c: string): string => {
    const upper = c.toUpperCase();
    if (!allowedCurrencies.includes(upper)) {
      fail(field, `${field} must be one of ${allowedCurrencies.join(', ')}`);
    }
    return upper;
  };

  let currency: string | null = null;
  if (isRevenue) {
    currency = checkCurrency('currency', input.currency ?? defaultCurrency);
  } else if (present(input.currency)) {
    fail('currency', 'currency only applies to a subscription revenue target');
  }

  const bonusType: SalesBonusType = input.bonusType ?? 'none';
  if (!(SALES_BONUS_TYPE as readonly string[]).includes(bonusType)) {
    fail('bonusType', 'Unknown bonus type');
  }

  const threshold = input.bonusThresholdPct;
  const checkThreshold = (required: boolean): number | null => {
    if (!present(threshold)) {
      if (required) fail('bonusThresholdPct', 'A threshold is required');
      return null;
    }
    const t = threshold as number;
    if (!Number.isFinite(t) || t <= 0 || t > SALES_THRESHOLD_PCT_MAX) {
      fail(
        'bonusThresholdPct',
        `Threshold must be above 0 and at most ${SALES_THRESHOLD_PCT_MAX}%`,
      );
    }
    return round2(t);
  };

  if (bonusType === 'none') {
    for (const f of [
      'bonusThresholdPct',
      'bonusAmount',
      'bonusPercent',
      'bonusCurrency',
    ] as const) {
      if (present(input[f])) fail(f, `${f} requires a bonus type`);
    }
    return {
      targetValue,
      currency,
      bonusType,
      bonusThresholdPct: null,
      bonusAmount: null,
      bonusPercent: null,
      bonusCurrency: null,
    };
  }

  if (bonusType === 'fixed_on_threshold') {
    if (present(input.bonusPercent)) {
      fail('bonusPercent', 'A fixed bonus has no percentage');
    }
    const amount = input.bonusAmount;
    if (
      !present(amount) ||
      !Number.isFinite(amount as number) ||
      (amount as number) <= 0 ||
      (amount as number) > SALES_AMOUNT_MAX
    ) {
      fail('bonusAmount', 'A fixed bonus needs an amount above 0');
    }
    return {
      targetValue,
      currency,
      bonusType,
      bonusThresholdPct: checkThreshold(true),
      bonusAmount: round2(amount as number),
      bonusPercent: null,
      bonusCurrency: checkCurrency(
        'bonusCurrency',
        input.bonusCurrency ?? currency ?? defaultCurrency,
      ),
    };
  }

  // percent_of_achieved
  if (!isRevenue) {
    fail(
      'bonusType',
      'A percentage bonus applies to subscription revenue targets only',
    );
  }
  if (present(input.bonusAmount)) {
    fail('bonusAmount', 'A percentage bonus has no fixed amount');
  }
  const pct = input.bonusPercent;
  if (
    !present(pct) ||
    !Number.isFinite(pct as number) ||
    (pct as number) <= 0 ||
    (pct as number) > 100
  ) {
    fail('bonusPercent', 'A percentage bonus needs a percentage above 0 and at most 100');
  }
  // The bonus is a share of revenue in the TARGET's currency; there is no FX
  // conversion anywhere in the platform, so any other bonus currency is refused.
  if (present(input.bonusCurrency) && input.bonusCurrency!.toUpperCase() !== currency) {
    fail(
      'bonusCurrency',
      'A percentage bonus is paid in the target currency',
    );
  }
  return {
    targetValue,
    currency,
    bonusType,
    bonusThresholdPct: checkThreshold(false),
    bonusAmount: null,
    bonusPercent: round2(pct as number),
    bonusCurrency: currency,
  };
}

/** Field-by-field equality of two normalized rules — used to skip no-op writes. */
export function sameSalesTargetRule(
  a: SalesTargetRule,
  b: SalesTargetRule,
): boolean {
  return (
    a.targetValue === b.targetValue &&
    a.currency === b.currency &&
    a.bonusType === b.bonusType &&
    a.bonusThresholdPct === b.bonusThresholdPct &&
    a.bonusAmount === b.bonusAmount &&
    a.bonusPercent === b.bonusPercent &&
    a.bonusCurrency === b.bonusCurrency
  );
}
