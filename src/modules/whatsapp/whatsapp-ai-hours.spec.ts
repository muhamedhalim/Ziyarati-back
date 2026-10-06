import { HoursRow, isOpenAt } from './whatsapp-ai-hours';

const row = (
  day: number,
  start: string,
  end: string,
  closed = false,
): HoursRow => ({
  day_of_week: day,
  start_time: start,
  end_time: end,
  is_closed: closed,
});

// Riyadh is UTC+3, no DST. 2026-01-04 is a Sunday (day 0).
const riyadh = (iso: string) => new Date(`${iso}+03:00`);
const TZ = 'Asia/Riyadh';

describe('isOpenAt', () => {
  it('returns null — not false — when the branch has no hours at all', () => {
    expect(isOpenAt([], TZ, riyadh('2026-01-04T10:00:00'))).toBeNull();
  });

  const SUN_TO_THU = [0, 1, 2, 3, 4].map((d) => row(d, '09:00:00', '17:00:00'));

  it('open inside a window, closed outside it, end exclusive', () => {
    expect(isOpenAt(SUN_TO_THU, TZ, riyadh('2026-01-04T09:00:00'))).toBe(true);
    expect(isOpenAt(SUN_TO_THU, TZ, riyadh('2026-01-04T16:59:00'))).toBe(true);
    expect(isOpenAt(SUN_TO_THU, TZ, riyadh('2026-01-04T17:00:00'))).toBe(false);
    expect(isOpenAt(SUN_TO_THU, TZ, riyadh('2026-01-04T08:59:00'))).toBe(false);
  });

  it('a weekday with no row is closed once the branch has listed its hours (Friday)', () => {
    expect(isOpenAt(SUN_TO_THU, TZ, riyadh('2026-01-09T11:00:00'))).toBe(false);
  });

  it('an explicit closed row is closed', () => {
    const rows = [row(0, '09:00:00', '17:00:00', true)];
    expect(isOpenAt(rows, TZ, riyadh('2026-01-04T11:00:00'))).toBe(false);
  });

  it("is judged in the BRANCH's timezone, not the server's: 22:00 UTC is already Monday 01:00 in Riyadh", () => {
    const monday = [row(1, '00:30:00', '02:00:00')];
    expect(isOpenAt(monday, TZ, new Date('2026-01-04T22:00:00Z'))).toBe(true);
    expect(isOpenAt(monday, 'UTC', new Date('2026-01-04T22:00:00Z'))).toBe(
      false,
    );
  });

  it('two windows in one day (split shift)', () => {
    const rows = [row(0, '09:00', '12:00'), row(0, '16:00', '20:00')];
    expect(isOpenAt(rows, TZ, riyadh('2026-01-04T14:00:00'))).toBe(false);
    expect(isOpenAt(rows, TZ, riyadh('2026-01-04T17:00:00'))).toBe(true);
  });

  it('an overnight window covers the rest of its day and the early hours of the next', () => {
    const rows = [row(0, '22:00:00', '02:00:00')]; // Sunday 22:00 → Monday 02:00
    expect(isOpenAt(rows, TZ, riyadh('2026-01-04T23:00:00'))).toBe(true);
    expect(isOpenAt(rows, TZ, riyadh('2026-01-05T01:00:00'))).toBe(true);
    expect(isOpenAt(rows, TZ, riyadh('2026-01-05T02:00:00'))).toBe(false);
    expect(isOpenAt(rows, TZ, riyadh('2026-01-04T21:00:00'))).toBe(false);
  });

  it('a window ending at midnight (18:00–00:00) does not spill into the next day', () => {
    const rows = [row(0, '18:00:00', '00:00:00')];
    expect(isOpenAt(rows, TZ, riyadh('2026-01-04T23:59:00'))).toBe(true);
    expect(isOpenAt(rows, TZ, riyadh('2026-01-05T00:00:00'))).toBe(false);
  });

  it('a bad timezone degrades to UTC instead of throwing', () => {
    expect(() =>
      isOpenAt(SUN_TO_THU, 'Not/AZone', new Date('2026-01-04T10:00:00Z')),
    ).not.toThrow();
    expect(
      isOpenAt(SUN_TO_THU, 'Not/AZone', new Date('2026-01-04T10:00:00Z')),
    ).toBe(true);
  });
});
