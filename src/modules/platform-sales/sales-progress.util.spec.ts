import { ErrorCode } from '../../common/errors';
import { parseSalesPeriod } from './sales-period.util';
import {
  expectedPercentage,
  salesPeriodsBetween,
  salesPhaseOf,
  salesProgress,
} from './sales-progress.util';

const at = (iso: string) => new Date(iso);

describe('salesPhaseOf', () => {
  const sept = parseSalesPeriod('2026-09');
  it('classifies past / current / future relative to now, in UTC', () => {
    expect(salesPhaseOf(sept, at('2026-10-01T00:00:00Z'))).toBe('past');
    expect(salesPhaseOf(sept, at('2026-09-30T23:59:59Z'))).toBe('current');
    expect(salesPhaseOf(sept, at('2026-09-01T00:00:00Z'))).toBe('current');
    expect(salesPhaseOf(sept, at('2026-08-31T23:59:59Z'))).toBe('future');
  });
});

describe('expectedPercentage', () => {
  const sept = parseSalesPeriod('2026-09'); // 30 days
  it('is 100 once the month has closed and 0 before it starts', () => {
    expect(expectedPercentage(sept, at('2026-10-05T00:00:00Z'))).toBe(100);
    expect(expectedPercentage(sept, at('2026-08-20T00:00:00Z'))).toBe(0);
  });
  it('is linear through the month', () => {
    expect(expectedPercentage(sept, at('2026-09-01T00:00:00Z'))).toBe(0);
    expect(expectedPercentage(sept, at('2026-09-16T00:00:00Z'))).toBe(50);
    expect(expectedPercentage(sept, at('2026-09-23T00:00:00Z'))).toBe(73.33);
  });
});

describe('salesProgress', () => {
  const sept = parseSalesPeriod('2026-09');
  const midMonth = at('2026-09-16T00:00:00Z'); // expects 50 %

  it('has no target: reports achieved but no percentage and no pace verdict', () => {
    expect(salesProgress(null, 7, sept, midMonth)).toEqual({
      target: null,
      achieved: 7,
      remaining: null,
      percentage: null,
      isCompleted: false,
      expectedPercentage: 50,
      onTrack: null,
    });
  });

  it('on track when at or above the linear pace', () => {
    expect(salesPro(10, 5)).toMatchObject({ percentage: 50, onTrack: true });
    expect(salesPro(10, 6)).toMatchObject({ percentage: 60, onTrack: true });
  });

  it('behind when below pace', () => {
    expect(salesPro(10, 4)).toMatchObject({ percentage: 40, onTrack: false, remaining: 6 });
  });

  it('reports an exceeded target uncapped and completed', () => {
    expect(salesPro(10, 13)).toMatchObject({
      percentage: 130,
      remaining: 0,
      isCompleted: true,
      onTrack: true,
    });
  });

  it('a target of 0 is trivially met', () => {
    expect(salesPro(0, 0)).toMatchObject({ percentage: 100, isCompleted: true, onTrack: true });
  });

  it('a closed month is on track only if the target was reached, regardless of pace', () => {
    const closed = at('2026-10-10T00:00:00Z');
    expect(salesProgress(10, 9, sept, closed).onTrack).toBe(false);
    expect(salesProgress(10, 10, sept, closed).onTrack).toBe(true);
  });

  it('a future month is never behind (pace is 0)', () => {
    const before = at('2026-08-01T00:00:00Z');
    expect(salesProgress(10, 0, sept, before)).toMatchObject({ percentage: 0, onTrack: true });
  });

  function salesPro(target: number, achieved: number) {
    return salesProgress(target, achieved, sept, midMonth);
  }
});

describe('salesPeriodsBetween', () => {
  it('lists every month inclusive, oldest first, across a year boundary', () => {
    expect(salesPeriodsBetween('2026-11', '2027-02').map((p) => p.period)).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });
  it('a single month', () => {
    expect(salesPeriodsBetween('2026-09', '2026-09')).toHaveLength(1);
  });
  it('refuses from > to', () => {
    expect(() => salesPeriodsBetween('2026-10', '2026-09')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
    );
  });
  it('allows 24 months and refuses 25', () => {
    expect(salesPeriodsBetween('2025-01', '2026-12')).toHaveLength(24);
    expect(() => salesPeriodsBetween('2025-01', '2027-01')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
    );
  });
});
