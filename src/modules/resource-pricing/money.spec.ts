import {
  MAX_SAFE_MINOR,
  assertSafeMinor,
  computeTotalMinor,
  computeDeltaUnits,
  toBigInt,
} from './money';

describe('money (Phase 2.1 — plan §21)', () => {
  describe('assertSafeMinor', () => {
    it('accepts zero and positive safe values', () => {
      expect(() => assertSafeMinor(0n, 'ctx')).not.toThrow();
      expect(() => assertSafeMinor(MAX_SAFE_MINOR, 'ctx')).not.toThrow();
    });

    it('rejects a negative value', () => {
      expect(() => assertSafeMinor(-1n, 'ctx')).toThrow(/must not be negative/);
    });

    it('rejects a value exceeding Number.MAX_SAFE_INTEGER', () => {
      expect(() => assertSafeMinor(MAX_SAFE_MINOR + 1n, 'ctx')).toThrow(
        /exceeds Number.MAX_SAFE_INTEGER/,
      );
    });

    it('names the context in the thrown message', () => {
      expect(() => assertSafeMinor(-1n, 'total_minor')).toThrow(/total_minor/);
    });
  });

  describe('computeTotalMinor / computeDeltaUnits — BigInt exactness at scale', () => {
    it('is exact at the 100,000-token AI-credit scale (plan §9 linear-scaling requirement)', () => {
      // 100,000 tokens priced per 1,000 (unitSize=1000) at 50 minor units/1k tokens.
      const unitPriceMinor = 50n;
      const quantity = 100n; // 100 * 1000 = 100,000 tokens
      const unitSize = 1000n;

      expect(computeTotalMinor(unitPriceMinor, quantity)).toBe(5000n); // exactly 100x the 1-unit price
      expect(computeDeltaUnits(unitSize, quantity)).toBe(100_000n);
    });

    it('scales linearly: 1,000 = X, 10,000 = 10X, 100,000 = 100X, with no float drift', () => {
      const unitPriceMinor = 33n; // deliberately not a round number
      const unitSize = 1000n;

      const oneK = { total: computeTotalMinor(unitPriceMinor, 1n), units: computeDeltaUnits(unitSize, 1n) };
      const tenK = { total: computeTotalMinor(unitPriceMinor, 10n), units: computeDeltaUnits(unitSize, 10n) };
      const hundredK = { total: computeTotalMinor(unitPriceMinor, 100n), units: computeDeltaUnits(unitSize, 100n) };

      expect(tenK.total).toBe(oneK.total * 10n);
      expect(hundredK.total).toBe(oneK.total * 100n);
      expect(tenK.units).toBe(oneK.units * 10n);
      expect(hundredK.units).toBe(oneK.units * 100n);
    });

    it('throws rather than silently overflow when a total would exceed safe-integer range', () => {
      const hugePriceMinor = MAX_SAFE_MINOR;
      expect(() => computeTotalMinor(hugePriceMinor, 2n)).toThrow(/exceeds Number.MAX_SAFE_INTEGER/);
    });
  });

  describe('toBigInt', () => {
    it('parses a pg bigint string column', () => {
      expect(toBigInt('123456789012')).toBe(123456789012n);
    });

    it('parses a plain number', () => {
      expect(toBigInt(42)).toBe(42n);
    });

    it('passes a bigint through unchanged', () => {
      expect(toBigInt(7n)).toBe(7n);
    });

    it('throws on a non-integer string, rather than silently truncating', () => {
      expect(() => toBigInt('12.5')).toThrow();
    });
  });
});
