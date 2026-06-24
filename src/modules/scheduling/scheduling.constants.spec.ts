import {
  toYmd,
  dayBoundsUtc,
  maxDate,
  minDate,
  overlaps,
  subtractIntervals,
  mergeIntervals,
  chunkIntervals,
  totalMinutes,
  Interval,
} from './scheduling.constants';

const iv = (s: string, e: string): Interval => ({ start: new Date(s), end: new Date(e) });

describe('scheduling.constants helpers', () => {
  it('toYmd handles Date and string', () => {
    expect(toYmd(new Date('2026-07-01T10:00:00Z'))).toBe('2026-07-01');
    expect(toYmd('2026-07-01T23:00:00Z')).toBe('2026-07-01');
  });

  it('dayBoundsUtc returns inclusive-start / exclusive-end day window', () => {
    const { dayStart, dayEnd } = dayBoundsUtc('2026-07-01');
    expect(dayStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(86_400_000);
  });

  it('maxDate / minDate pick the correct bound', () => {
    const a = new Date('2026-01-01');
    const b = new Date('2026-02-01');
    expect(maxDate(a, b)).toBe(b);
    expect(minDate(a, b)).toBe(a);
  });

  it('overlaps detects half-open overlap', () => {
    expect(overlaps(iv('2026-07-01T10:00Z', '2026-07-01T11:00Z'), iv('2026-07-01T10:30Z', '2026-07-01T12:00Z'))).toBe(true);
    // abutting → no overlap
    expect(overlaps(iv('2026-07-01T10:00Z', '2026-07-01T11:00Z'), iv('2026-07-01T11:00Z', '2026-07-01T12:00Z'))).toBe(false);
  });

  describe('subtractIntervals', () => {
    it('returns empty for an inverted slot', () => {
      expect(subtractIntervals(iv('2026-07-01T11:00Z', '2026-07-01T10:00Z'), [])).toEqual([]);
    });

    it('carves out a busy block in the middle', () => {
      const free = subtractIntervals(iv('2026-07-01T09:00Z', '2026-07-01T17:00Z'), [
        iv('2026-07-01T12:00Z', '2026-07-01T13:00Z'),
      ]);
      expect(free).toHaveLength(2);
      expect(free[0].end.toISOString()).toBe('2026-07-01T12:00:00.000Z');
      expect(free[1].start.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    });

    it('returns the whole slot when no busy overlaps', () => {
      const free = subtractIntervals(iv('2026-07-01T09:00Z', '2026-07-01T10:00Z'), [
        iv('2026-07-01T20:00Z', '2026-07-01T21:00Z'),
      ]);
      expect(free).toHaveLength(1);
    });
  });

  describe('mergeIntervals', () => {
    it('merges overlapping/adjacent and keeps disjoint', () => {
      const merged = mergeIntervals([
        iv('2026-07-01T09:00Z', '2026-07-01T10:00Z'),
        iv('2026-07-01T09:30Z', '2026-07-01T11:00Z'),
        iv('2026-07-01T12:00Z', '2026-07-01T13:00Z'),
      ]);
      expect(merged).toHaveLength(2);
      expect(merged[0].end.toISOString()).toBe('2026-07-01T11:00:00.000Z');
    });

    it('returns empty for no intervals', () => {
      expect(mergeIntervals([])).toEqual([]);
    });
  });

  it('chunkIntervals splits into fixed slots dropping remainders', () => {
    const chunks = chunkIntervals([iv('2026-07-01T09:00Z', '2026-07-01T10:10Z')], 30);
    expect(chunks).toHaveLength(2); // 09:00–09:30, 09:30–10:00 (10 min remainder dropped)
  });

  it('totalMinutes sums interval durations', () => {
    expect(totalMinutes([iv('2026-07-01T09:00Z', '2026-07-01T10:00Z'), iv('2026-07-01T10:00Z', '2026-07-01T10:30Z')])).toBe(90);
  });
});
