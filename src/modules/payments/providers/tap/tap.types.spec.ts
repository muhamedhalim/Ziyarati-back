import {
  currencyDecimals,
  formatTapAmount,
  toDomainMinorUnits,
  toTapAmount,
} from './tap.types';

describe('Tap amount helpers', () => {
  it('currencyDecimals: BHD/KWD/OMR/JOD are 3, everything else (incl. SAR) is 2', () => {
    expect(currencyDecimals('SAR')).toBe(2);
    expect(currencyDecimals('usd')).toBe(2);
    expect(currencyDecimals(undefined)).toBe(2);
    for (const c of ['BHD', 'KWD', 'omr', 'JOD'])
      expect(currencyDecimals(c)).toBe(3);
  });

  describe('formatTapAmount (signature text)', () => {
    it.each([
      [1, 'SAR', '1.00'],
      [49.99, 'SAR', '49.99'],
      ['12.5', 'SAR', '12.50'],
      [1, 'KWD', '1.000'],
      [0.1 + 0.2, 'SAR', '0.30'], // float drift must not leak into the signed text
      [10, 'XYZ', '10.00'],
    ])('%p %s → %s', (amount, currency, expected) => {
      expect(formatTapAmount(amount as any, currency)).toBe(expected);
    });

    it.each([[undefined], [null], [''], ['abc'], [NaN], [Infinity]])(
      'cannot format %p → null (so a malformed payload never produces a matching signature)',
      (amount) => {
        expect(formatTapAmount(amount as any, 'SAR')).toBeNull();
      },
    );
  });

  describe('toTapAmount (request body)', () => {
    // Domain amounts are already rounded to 2dp (round2); inputs finer than the
    // currency's own decimals are out of contract, so only unambiguous values here.
    it('rounds to the currency decimals as a JSON number', () => {
      expect(toTapAmount(49.999, 'SAR')).toBe(50);
      expect(toTapAmount(49.994, 'SAR')).toBe(49.99);
      expect(toTapAmount(1.2346, 'KWD')).toBe(1.235);
      expect(toTapAmount(1.2344, 'KWD')).toBe(1.234);
      expect(typeof toTapAmount(10, 'SAR')).toBe('number');
    });
  });

  describe('toDomainMinorUnits (the domain compares in x100 cents)', () => {
    it('converts major units with the SAME x100 the domain uses', () => {
      expect(toDomainMinorUnits(49.99)).toBe(4999);
      expect(toDomainMinorUnits('200')).toBe(20000);
      expect(toDomainMinorUnits(0.29)).toBe(29); // 0.29*100 = 28.999… must round, not truncate
    });
    it('is bit-for-bit the domain formula, so captured-vs-expected never disagrees on float noise', () => {
      // assertCapturedMatches / reconciliation / webhook all compute Math.round(Number(x) * 100).
      for (const v of [1.005, 0.29, 4.35, 8.2, 19.99, 0.1 + 0.2, 1234.565]) {
        expect(toDomainMinorUnits(v)).toBe(Math.round(Number(v) * 100));
      }
    });
    it('returns undefined — never a guess — for a missing/garbage amount', () => {
      expect(toDomainMinorUnits(undefined)).toBeUndefined();
      expect(toDomainMinorUnits('')).toBeUndefined();
      expect(toDomainMinorUnits('x')).toBeUndefined();
    });
  });
});
