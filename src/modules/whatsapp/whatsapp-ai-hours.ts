import {
  safeZone,
  zonedDayBoundsUtc,
  zonedYmd,
} from '../scheduling/timezone.util';

/** The slice of a `working_hours` row the AI schedule needs. */
export interface HoursRow {
  day_of_week: number; // 0 = Sunday … 6 = Saturday, in the branch's local calendar
  start_time: string; // 'HH:MM[:SS]'
  end_time: string;
  is_closed: boolean;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};

/**
 * Is a branch open at `at`, judged in the BRANCH's own timezone?
 *
 *  - `null`  — nothing is configured, so open/closed cannot be judged. The caller
 *    treats the schedule as not applicable rather than guessing: a clinic that
 *    never entered hours must not have its AI silently switched off (or on).
 *  - `true` / `false` — hours exist for the branch. A weekday with no row, or
 *    only an explicit closed row, is CLOSED: once a branch lists its hours, a day
 *    it did not list is a day it is not open. (Staff booking availability reads an
 *    unlisted day as "no extra constraint"; that is about who can be booked, this
 *    is about whether the clinic is open, and the two questions differ.)
 *
 * A window whose end is not after its start crosses midnight (22:00–02:00, or
 * 18:00–00:00): it covers the rest of its own day and spills into the next.
 */
export function isOpenAt(
  rows: HoursRow[],
  timezone: string | null | undefined,
  at: Date,
): boolean | null {
  if (rows.length === 0) return null;

  const tz = safeZone(timezone);
  const ymd = zonedYmd(at, tz);
  const weekday = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  const minute = Math.floor(
    (at.getTime() - zonedDayBoundsUtc(ymd, tz).dayStart.getTime()) / 60_000,
  );
  const previousWeekday = (weekday + 6) % 7;

  for (const r of rows) {
    if (r.is_closed) continue;
    const start = toMinutes(r.start_time);
    const end = toMinutes(r.end_time);
    const crossesMidnight = end <= start;

    if (r.day_of_week === weekday) {
      if (crossesMidnight ? minute >= start : minute >= start && minute < end) {
        return true;
      }
    }
    // The tail of yesterday's overnight window.
    if (r.day_of_week === previousWeekday && crossesMidnight && minute < end) {
      return true;
    }
  }
  return false;
}
