import { ErrorCode } from '../../common/errors';
import {
  normalizeSalesTargetRule,
  sameSalesTargetRule,
} from './sales-target-rule.util';

const ALLOWED = ['SAR', 'USD', 'AED', 'EGP'];
const norm = (
  metric: Parameters<typeof normalizeSalesTargetRule>[0],
  input: Parameters<typeof normalizeSalesTargetRule>[1],
) => normalizeSalesTargetRule(metric, input, 'SAR', ALLOWED);

const failsOn = (fn: () => unknown, field: string) => {
  try {
    fn();
  } catch (e) {
    expect((e as { code: string }).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((e as { publicContext?: { field?: string } }).publicContext?.field).toBe(field);
    return;
  }
  throw new Error(`expected a validation error on ${field}`);
};

describe('normalizeSalesTargetRule — target value and currency', () => {
  it('a plain clinic target has no currency and no bonus', () => {
    expect(norm('new_clinics', { targetValue: 12 })).toEqual({
      targetValue: 12,
      currency: null,
      bonusType: 'none',
      bonusThresholdPct: null,
      bonusAmount: null,
      bonusPercent: null,
      bonusCurrency: null,
    });
  });

  it('counts must be whole numbers; revenue may have cents', () => {
    failsOn(() => norm('new_clinics', { targetValue: 2.5 }), 'targetValue');
    failsOn(() => norm('paid_conversions', { targetValue: 0.1 }), 'targetValue');
    expect(norm('subscription_revenue', { targetValue: 1234.5 }).targetValue).toBe(1234.5);
  });

  it('rejects negative, NaN and infinite values', () => {
    for (const v of [-1, NaN, Infinity]) {
      failsOn(() => norm('subscription_revenue', { targetValue: v }), 'targetValue');
    }
  });

  it('a target of 0 is allowed', () => {
    expect(norm('new_clinics', { targetValue: 0 }).targetValue).toBe(0);
  });

  it('a revenue target defaults to the platform currency and upper-cases an explicit one', () => {
    expect(norm('subscription_revenue', { targetValue: 5 }).currency).toBe('SAR');
    expect(norm('subscription_revenue', { targetValue: 5, currency: 'usd' }).currency).toBe('USD');
  });

  it('rejects a currency the platform does not bill in', () => {
    failsOn(() => norm('subscription_revenue', { targetValue: 5, currency: 'JPY' }), 'currency');
  });

  it('refuses a currency on a non-revenue target (the DB CHECK would otherwise 500)', () => {
    failsOn(() => norm('new_clinics', { targetValue: 5, currency: 'SAR' }), 'currency');
  });
});

describe('normalizeSalesTargetRule — bonus rules', () => {
  it('bonusType none refuses stray bonus fields', () => {
    for (const f of ['bonusAmount', 'bonusPercent', 'bonusThresholdPct'] as const) {
      failsOn(() => norm('new_clinics', { targetValue: 5, [f]: 10 }), f);
    }
  });

  it('fixed_on_threshold needs an amount and a threshold', () => {
    failsOn(
      () => norm('new_clinics', { targetValue: 5, bonusType: 'fixed_on_threshold', bonusThresholdPct: 100 }),
      'bonusAmount',
    );
    failsOn(
      () => norm('new_clinics', { targetValue: 5, bonusType: 'fixed_on_threshold', bonusAmount: 500 }),
      'bonusThresholdPct',
    );
    failsOn(
      () => norm('new_clinics', { targetValue: 5, bonusType: 'fixed_on_threshold', bonusAmount: 0, bonusThresholdPct: 100 }),
      'bonusAmount',
    );
  });

  it('fixed_on_threshold refuses a percentage and defaults its currency', () => {
    failsOn(
      () =>
        norm('new_clinics', {
          targetValue: 5,
          bonusType: 'fixed_on_threshold',
          bonusAmount: 500,
          bonusThresholdPct: 100,
          bonusPercent: 3,
        }),
      'bonusPercent',
    );
    expect(
      norm('new_clinics', {
        targetValue: 5,
        bonusType: 'fixed_on_threshold',
        bonusAmount: 500,
        bonusThresholdPct: 100,
      }),
    ).toMatchObject({ bonusAmount: 500, bonusThresholdPct: 100, bonusPercent: null, bonusCurrency: 'SAR' });
  });

  it('a fixed bonus on a revenue target follows the target currency by default', () => {
    expect(
      norm('subscription_revenue', {
        targetValue: 1000,
        currency: 'USD',
        bonusType: 'fixed_on_threshold',
        bonusAmount: 100,
        bonusThresholdPct: 100,
      }).bonusCurrency,
    ).toBe('USD');
  });

  it('percent_of_achieved is revenue-only', () => {
    failsOn(
      () => norm('new_clinics', { targetValue: 5, bonusType: 'percent_of_achieved', bonusPercent: 5 }),
      'bonusType',
    );
  });

  it('percent_of_achieved needs a percentage in (0, 100], refuses an amount, threshold optional', () => {
    const base = { targetValue: 1000, bonusType: 'percent_of_achieved' as const };
    failsOn(() => norm('subscription_revenue', base), 'bonusPercent');
    failsOn(() => norm('subscription_revenue', { ...base, bonusPercent: 0 }), 'bonusPercent');
    failsOn(() => norm('subscription_revenue', { ...base, bonusPercent: 101 }), 'bonusPercent');
    failsOn(() => norm('subscription_revenue', { ...base, bonusPercent: 5, bonusAmount: 10 }), 'bonusAmount');
    expect(norm('subscription_revenue', { ...base, bonusPercent: 5 })).toMatchObject({
      bonusPercent: 5,
      bonusThresholdPct: null,
      bonusAmount: null,
      bonusCurrency: 'SAR',
    });
    expect(
      norm('subscription_revenue', { ...base, bonusPercent: 5, bonusThresholdPct: 80 }).bonusThresholdPct,
    ).toBe(80);
  });

  it('a percentage bonus cannot be paid in another currency (no FX)', () => {
    failsOn(
      () =>
        norm('subscription_revenue', {
          targetValue: 1000,
          currency: 'SAR',
          bonusType: 'percent_of_achieved',
          bonusPercent: 5,
          bonusCurrency: 'USD',
        }),
      'bonusCurrency',
    );
  });

  it('rejects thresholds outside (0, 1000]', () => {
    for (const t of [0, -5, 1001]) {
      failsOn(
        () =>
          norm('new_clinics', {
            targetValue: 5,
            bonusType: 'fixed_on_threshold',
            bonusAmount: 10,
            bonusThresholdPct: t,
          }),
        'bonusThresholdPct',
      );
    }
  });

  it('rounds to cents', () => {
    expect(norm('subscription_revenue', { targetValue: 10.004 }).targetValue).toBe(10);
  });
});

describe('sameSalesTargetRule', () => {
  const a = norm('new_clinics', { targetValue: 5 });
  it('is true for identical rules and false when any field differs', () => {
    expect(sameSalesTargetRule(a, { ...a })).toBe(true);
    expect(sameSalesTargetRule(a, { ...a, targetValue: 6 })).toBe(false);
    expect(sameSalesTargetRule(a, { ...a, bonusType: 'fixed_on_threshold' })).toBe(false);
    expect(sameSalesTargetRule(a, { ...a, bonusThresholdPct: 100 })).toBe(false);
    expect(sameSalesTargetRule(a, { ...a, currency: 'SAR' })).toBe(false);
  });
});
