import { ErrorCode } from '../../common/errors';
import {
  currentSalesPeriod,
  isPastSalesPeriod,
  parseSalesPeriod,
  salesPeriodOf,
} from './sales-period.util';

describe('parseSalesPeriod', () => {
  it('computes UTC month bounds [start, end)', () => {
    const p = parseSalesPeriod('2026-09');
    expect(p.periodMonth).toBe('2026-09-01');
    expect(p.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(p.daysInMonth).toBe(30);
  });

  it('rolls December into January of the next year', () => {
    const p = parseSalesPeriod('2026-12');
    expect(p.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(p.daysInMonth).toBe(31);
  });

  it.each([
    ['2024-02', 29],
    ['2025-02', 28],
    ['2100-02', 28], // century, not a leap year
    ['2000-02', 29], // divisible by 400
  ])('%s has %i days', (period, days) => {
    expect(parseSalesPeriod(period).daysInMonth).toBe(days);
  });

  it.each(['2026-9', '2026-13', '2026-00', '26-09', '2026-09-01', '', 'abc'])(
    'rejects %p',
    (bad) => {
      expect(() => parseSalesPeriod(bad)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
      );
    },
  );
});

describe('salesPeriodOf / currentSalesPeriod', () => {
  it('reads the UTC month, not the local one', () => {
    // 23:30 UTC on the last day of September is still September, whatever the host offset is.
    expect(salesPeriodOf(new Date('2026-09-30T23:30:00.000Z'))).toBe('2026-09');
    expect(salesPeriodOf(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10');
  });

  it('currentSalesPeriod honours the injected clock', () => {
    expect(currentSalesPeriod(new Date('2026-02-14T10:00:00Z')).period).toBe(
      '2026-02',
    );
  });
});

describe('isPastSalesPeriod', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  it('is true only for months that have fully ended', () => {
    expect(isPastSalesPeriod(parseSalesPeriod('2026-08'), now)).toBe(true);
    expect(isPastSalesPeriod(parseSalesPeriod('2025-12'), now)).toBe(true);
  });
  it('is false for the current and future months', () => {
    expect(isPastSalesPeriod(parseSalesPeriod('2026-09'), now)).toBe(false);
    expect(isPastSalesPeriod(parseSalesPeriod('2026-10'), now)).toBe(false);
  });
  it('flips at the exact instant the month rolls over', () => {
    const p = parseSalesPeriod('2026-09');
    expect(isPastSalesPeriod(p, new Date('2026-09-30T23:59:59.999Z'))).toBe(
      false,
    );
    expect(isPastSalesPeriod(p, new Date('2026-10-01T00:00:00.000Z'))).toBe(
      true,
    );
  });
});
