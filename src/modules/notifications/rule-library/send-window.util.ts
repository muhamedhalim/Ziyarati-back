/**
 * Quiet hours for rule-scheduled messages: a patient should not be woken at 3 a.m.
 * by a reminder. A send window is a clinic-LOCAL range of hours (default 09:00 up
 * to 21:00); a time outside it is moved to the nearest allowed time.
 *
 * Pure and dependency-free so DST and "tomorrow" cases are unit-testable. The
 * clinic's timezone comes from `tenants.default_timezone`; an unknown zone falls
 * back to UTC rather than throwing inside the scheduling path.
 */
export interface SendWindow {
  /** First allowed hour, 0–23 (inclusive). */
  startHour: number;
  /** First hour that is NOT allowed, 1–24 (exclusive). */
  endHour: number;
}

export const DEFAULT_SEND_WINDOW: SendWindow = { startHour: 9, endHour: 21 };

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

function partsIn(date: Date, timeZone: string): Parts {
  const options = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  } as const;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: 'UTC',
    }).formatToParts(date);
  }
  const num = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    y: num('year'),
    m: num('month'),
    d: num('day'),
    h: num('hour'),
    min: num('minute'),
  };
}

/** The UTC instant at which a clinic's wall clock reads y-m-d h:min. */
function utcFromLocal(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  tz: string,
): Date {
  const wanted = Date.UTC(y, m - 1, d, h, min);
  let guess = wanted;
  // Two passes settle the offset, including across a DST change.
  for (let i = 0; i < 2; i += 1) {
    const p = partsIn(new Date(guess), tz);
    guess -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - wanted;
  }
  return new Date(guess);
}

export function isValidSendWindow(w: unknown): w is SendWindow {
  const x = w as SendWindow;
  return (
    !!x &&
    Number.isInteger(x.startHour) &&
    Number.isInteger(x.endHour) &&
    x.startHour >= 0 &&
    x.startHour <= 23 &&
    x.endHour >= 1 &&
    x.endHour <= 24 &&
    x.startHour < x.endHour
  );
}

export function inWindow(at: Date, tz: string, w: SendWindow): boolean {
  const { h } = partsIn(at, tz);
  return h >= w.startHour && h < w.endHour;
}

/**
 * Moves `at` into the window.
 *
 *  - Already inside → unchanged.
 *  - Outside → the next window opening (later today, or tomorrow morning).
 *  - If that would land after `notAfter` (e.g. the appointment itself, so a
 *    reminder would arrive late), the nearest window CLOSING before `at` is used
 *    instead — a reminder at 20:59 the evening before beats none at all.
 *  - If neither is usable (`earliest` = now), returns `null`: skip, never a
 *    message at a wrong hour.
 */
export function shiftIntoWindow(
  at: Date,
  tz: string,
  w: SendWindow,
  opts: { notAfter?: Date; earliest?: Date } = {},
): Date | null {
  if (inWindow(at, tz, w)) return at;

  const p = partsIn(at, tz);
  const opening = (dayOffset: number) =>
    utcFromLocal(p.y, p.m, p.d + dayOffset, w.startHour, 0, tz);
  const closing = (dayOffset: number) =>
    // One minute before the closing hour so the result is still INSIDE the window.
    new Date(
      utcFromLocal(p.y, p.m, p.d + dayOffset, w.endHour, 0, tz).getTime() -
        60_000,
    );

  const later = p.h < w.startHour ? opening(0) : opening(1);
  if (!opts.notAfter || later.getTime() <= opts.notAfter.getTime())
    return later;

  const earlier = p.h >= w.endHour ? closing(0) : closing(-1);
  if (!opts.earliest || earlier.getTime() > opts.earliest.getTime())
    return earlier;
  return null;
}
