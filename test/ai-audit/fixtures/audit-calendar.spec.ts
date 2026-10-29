/**
 * Regression for the 2026-10-29 ai-audit CI failure (det-01 / det-02 / det-08 / det-09: 7 tests).
 *
 * ROOT CAUSE. The seeded clinics are open Sun-Thu and closed Fri/Sat. On a Thursday, after the last
 * slot of the day, an availability search of `daysAhead: 3` (today..today+2) contains no bookable
 * day: the tool then answers with an EMPTY `days` and the open days in `nextAvailable` (by design).
 * The specs read `days`, so `firstFullDay` threw "no availability day after 2026-10-29: []" and
 * det-09 sliced `undefined` slots ("Invalid time value"). Separately, the seed placed its CONFIRMED
 * appointment "+3 days" — the coming Sunday, which on a Thursday IS the first open day — so that
 * day's grid for the same doctor was shifted (det-01: 09:00 / 10:45 / 11:30 instead of 09:00 /
 * 09:45 / 10:30). Both only happen on certain weekdays, so they passed on most days and failed on
 * the day CI ran.
 *
 * These checks are pure (no database): they walk every weekday x several hours of a clinic week and
 * prove the calendar helpers and the search horizon behave the same on all of them.
 */
import {
  OPEN_WEEKDAYS,
  clinicDate,
  seededAppointmentStart,
  upcomingOpenDays,
} from './audit-seed';
import { AVAILABILITY_HORIZON_DAYS, firstFullDay } from './audit-runtime';

const DAY_MS = 86_400_000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 2026-10-25 is a Sunday. Every (weekday, clinic-local hour) of one week, as a UTC instant (UTC+3, no DST). */
const SUNDAY = Date.UTC(2026, 9, 25, 0, 0, 0) - 3 * 3_600_000;
const INSTANTS = WEEKDAY.flatMap((name, dow) =>
  [0, 6, 9, 12, 16, 17, 20, 23].map((hour) => ({
    label: `${name} ${String(hour).padStart(2, '0')}:30`,
    now: new Date(SUNDAY + dow * DAY_MS + hour * 3_600_000 + 30 * 60_000),
  })),
);

const weekdayOfDate = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

describe('audit calendar helpers hold on every weekday and hour', () => {
  it.each(INSTANTS)('$label: upcoming open days are real open weekdays, strictly after today, in order', ({ now }) => {
    const days = upcomingOpenDays(now, 4);
    expect(days).toHaveLength(4);
    for (const d of days) {
      expect(d > clinicDate(now)).toBe(true);
      expect(OPEN_WEEKDAYS).toContain(weekdayOfDate(d));
    }
    expect([...days].sort()).toEqual(days);
    expect(new Set(days).size).toBe(4);
  });

  it.each(INSTANTS)(
    '$label: the seeded appointment is on the SECOND open day, never the first, and more than a day away',
    ({ now }) => {
      const [first, second] = upcomingOpenDays(now, 2);
      const start = seededAppointmentStart(now);

      expect(clinicDate(start)).toBe(second);
      expect(clinicDate(start)).not.toBe(first); // the first full day stays a clean grid
      expect(start.getTime() - now.getTime()).toBeGreaterThan(24 * 3_600_000); // 24 h cancellation policy never applies
      expect(OPEN_WEEKDAYS).toContain(weekdayOfDate(clinicDate(start)));
    },
  );

  it.each(INSTANTS)(
    '$label: a search of AVAILABILITY_HORIZON_DAYS contains an open day after today (the old 3-day window did not)',
    ({ now }) => {
      const window = (n: number) =>
        Array.from({ length: n }, (_, i) => clinicDate(new Date(now.getTime() + i * DAY_MS)));
      const today = clinicDate(now);
      const bookableAfterToday = (n: number) =>
        window(n).filter((d) => d > today && OPEN_WEEKDAYS.includes(weekdayOfDate(d)));

      expect(bookableAfterToday(AVAILABILITY_HORIZON_DAYS).length).toBeGreaterThan(0);
    },
  );

  it('documents the failure: a 3-day window from a Thursday holds no open day after today', () => {
    const thursday = INSTANTS.find((i) => i.label === 'Thu 17:30')!.now;
    const today = clinicDate(thursday);
    const window = Array.from({ length: 3 }, (_, i) => clinicDate(new Date(thursday.getTime() + i * DAY_MS)));
    expect(window.filter((d) => d > today && OPEN_WEEKDAYS.includes(weekdayOfDate(d)))).toEqual([]);
  });

  it('has a horizon that cannot be silently shrunk below a week', () => {
    expect(AVAILABILITY_HORIZON_DAYS).toBeGreaterThanOrEqual(7);
  });
});

describe('firstFullDay', () => {
  const today = clinicDate(new Date());
  const later = clinicDate(new Date(Date.now() + 3 * DAY_MS));

  it('returns the first day strictly after today', () => {
    expect(firstFullDay([{ date: today }, { date: later }]).date).toBe(later);
  });

  it('fails with an actionable message, naming nextAvailable and the horizon, when `days` has nothing after today', () => {
    const nextAvailable = [{ date: later, slots: [] }];
    expect(() => firstFullDay([], { nextAvailable })).toThrow(/nextAvailable=.*AVAILABILITY_HORIZON_DAYS \(7\)/s);
    expect(() => firstFullDay([{ date: today }])).toThrow(/no availability day after/);
  });
});
