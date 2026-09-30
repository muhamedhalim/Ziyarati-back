import {
  computeBonus,
  meetsThreshold,
  storedAchievementPct,
} from './sales-bonus.util';
import type { SalesBonusRuleLike } from './sales-bonus.util';

const fixed = (
  thresholdPct: number,
  amount: number,
  currency = 'SAR',
): SalesBonusRuleLike => ({
  type: 'fixed_on_threshold',
  thresholdPct,
  amount,
  percent: null,
  currency,
});

const percent = (
  pct: number,
  thresholdPct: number | null = null,
  currency = 'SAR',
): SalesBonusRuleLike => ({
  type: 'percent_of_achieved',
  thresholdPct,
  amount: null,
  percent: pct,
  currency,
});

describe('meetsThreshold', () => {
  it('is inclusive at exactly the threshold', () => {
    expect(meetsThreshold(100, 100, 100)).toBe(true);
    expect(meetsThreshold(10, 8, 80)).toBe(true);
  });

  it('is false one cent short, even though the rounded percentage reads 100', () => {
    // 99 999.99 / 100 000.00 = 99.99999 % — displayed as "100 %" but NOT reached.
    expect(meetsThreshold(100_000, 99_999.99, 100)).toBe(false);
    expect(meetsThreshold(100_000, 100_000, 100)).toBe(true);
  });

  it('is exact where float division is not', () => {
    // 1.05 / 3 * 100 = 35.00000000000001 in floats; the intent is "exactly 35 %".
    expect(meetsThreshold(3, 1.05, 35)).toBe(true);
    expect(meetsThreshold(3, 1.04, 35)).toBe(false);
    expect(meetsThreshold(1, 0.3, 30)).toBe(true);
  });

  it('handles thresholds above 100 (a stretch goal)', () => {
    expect(meetsThreshold(10, 15, 150)).toBe(true);
    expect(meetsThreshold(10, 14, 150)).toBe(false);
  });

  it('treats a target of 0 as fully reached, up to a threshold of 100', () => {
    expect(meetsThreshold(0, 0, 100)).toBe(true);
    expect(meetsThreshold(0, 5, 100)).toBe(true);
    expect(meetsThreshold(0, 5, 100.01)).toBe(false);
  });

  it('does not lose precision on the largest amounts a column can hold', () => {
    const max = 999_999_999_999.99;
    expect(meetsThreshold(max, max, 100)).toBe(true);
    expect(meetsThreshold(max, max - 0.01, 100)).toBe(false);
  });
});

describe('computeBonus', () => {
  it('a rule of type none pays nothing and is not applicable', () => {
    expect(
      computeBonus(
        { type: 'none', thresholdPct: null, amount: null, percent: null, currency: null },
        10,
        99,
      ),
    ).toEqual({ applicable: false, thresholdMet: false, amount: 0, currency: null });
  });

  describe('fixed_on_threshold', () => {
    it('pays the fixed amount once the threshold is met', () => {
      expect(computeBonus(fixed(100, 500), 4, 4)).toEqual({
        applicable: true,
        thresholdMet: true,
        amount: 500,
        currency: 'SAR',
      });
    });

    it('pays the same fixed amount when the target is exceeded (it does not scale)', () => {
      expect(computeBonus(fixed(100, 500), 4, 40).amount).toBe(500);
    });

    it('pays nothing below the threshold', () => {
      expect(computeBonus(fixed(100, 500), 4, 3)).toMatchObject({
        applicable: true,
        thresholdMet: false,
        amount: 0,
      });
    });

    it('honours a threshold below 100 %', () => {
      expect(computeBonus(fixed(75, 200), 4, 3).amount).toBe(200);
      expect(computeBonus(fixed(75, 200), 4, 2).amount).toBe(0);
    });

    it('keeps the rule currency even when nothing is earned', () => {
      expect(computeBonus(fixed(100, 500, 'AED'), 4, 0).currency).toBe('AED');
    });
  });

  describe('percent_of_achieved', () => {
    it('pays a share of the achieved revenue', () => {
      expect(computeBonus(percent(5), 1000, 1000).amount).toBe(50);
      expect(computeBonus(percent(5), 1000, 1500).amount).toBe(75); // exceeded target pays more
    });

    it('with no threshold it pays on whatever was achieved', () => {
      expect(computeBonus(percent(10), 1000, 300)).toMatchObject({
        thresholdMet: true,
        amount: 30,
      });
    });

    it('with a threshold it pays nothing until the threshold is met', () => {
      expect(computeBonus(percent(10, 100), 1000, 999.99)).toMatchObject({
        thresholdMet: false,
        amount: 0,
      });
      expect(computeBonus(percent(10, 100), 1000, 1000).amount).toBe(100);
    });

    it('rounds half-up to the cent, without float drift', () => {
      expect(computeBonus(percent(50), 1, 0.05).amount).toBe(0.03); // 0.025
      expect(computeBonus(percent(33.33), 100, 100.1).amount).toBe(33.36); // 33.3633
      expect(computeBonus(percent(12.5), 1000, 1234.56).amount).toBe(154.32);
      expect(computeBonus(percent(0.01), 1000, 999_999_999_999.99).amount).toBe(100_000_000);
    });

    it('pays nothing on zero revenue', () => {
      expect(computeBonus(percent(10), 1000, 0).amount).toBe(0);
    });
  });
});

describe('storedAchievementPct', () => {
  it('passes a normal percentage through', () => {
    expect(storedAchievementPct(133.33)).toBe(133.33);
    expect(storedAchievementPct(0)).toBe(0);
  });

  it('caps at what numeric(8,2) can hold and never returns NaN or a negative', () => {
    expect(storedAchievementPct(5_000_000)).toBe(999_999.99);
    expect(storedAchievementPct(-3)).toBe(0);
    expect(storedAchievementPct(null)).toBe(0);
    expect(storedAchievementPct(Number.NaN)).toBe(0);
  });
});
