/**
 * Timezone helpers for the availability engine — dependency-free, DST-correct.
 *
 * Backed by the Intl/ICU IANA database (bundled with Node), so it handles any
 * `Asia/Riyadh`, `Africa/Cairo`, `Asia/Beirut`, … and their DST rules without a
 * third-party library. The engine evaluates working hours / holidays / day
 * boundaries in the BRANCH's local timezone, while appointments stay stored as
 * UTC `timestamptz`.
 *
 * Model:
 *   input (absolute ISO)  → stored UTC          (no conversion needed)
 *   local wall-clock      → UTC instant         (zonedWallToUtc / zonedHhmmToUtc)
 *   UTC instant           → local calendar date (zonedYmd)
 *   local date            → [startUtc, endUtc)  (zonedDayBoundsUtc)
 */

const FALLBACK_ZONE = 'UTC';
const _fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Validate an IANA zone id; falls callers back to UTC when invalid/misconfigured. */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Never let a bad branch.timezone break booking — degrade to UTC. */
export function safeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? (tz as string) : FALLBACK_ZONE;
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = _fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    _fmtCache.set(tz, f);
  }
  return f;
}

interface ZonedParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function partsInZone(date: Date, tz: string): ZonedParts {
  const map: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return {
    y: +map.year,
    mo: +map.month,
    d: +map.day,
    h: +map.hour,
    mi: +map.minute,
    s: +map.second,
  };
}

/** Offset (ms) of `tz` at the given instant: (zone wall-clock) − UTC. */
function offsetMs(date: Date, tz: string): number {
  const p = partsInZone(date, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - date.getTime();
}

/** Local calendar date 'YYYY-MM-DD' of an instant, in `tz`. */
export function zonedYmd(date: Date, tz: string): string {
  const z = safeZone(tz);
  const p = partsInZone(date, z);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * Wall-clock (y, mo, d, h, mi) in `tz` → the matching UTC instant. Two-pass so a
 * DST transition between the guess and the real offset is corrected. (For KSA /
 * most Arab zones there is no DST, so this is a fixed offset; the two-pass keeps
 * it correct for Cairo/Beirut/… when the region expands.)
 */
export function zonedWallToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): Date {
  const z = safeZone(tz);
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = offsetMs(new Date(guessUtc), z);
  const off2 = offsetMs(new Date(guessUtc - off1), z);
  return new Date(guessUtc - off2);
}

/** Local 'HH:MM' on local date `dateStr` ('YYYY-MM-DD') in `tz` → UTC Date. */
export function zonedHhmmToUtc(dateStr: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.slice(0, 5).split(':').map(Number);
  return zonedWallToUtc(y, mo, d, h, mi, tz);
}

/** Local day [00:00, next-day 00:00) for `dateStr` in `tz`, as UTC bounds. */
export function zonedDayBoundsUtc(
  dateStr: string,
  tz: string,
): { dayStart: Date; dayEnd: Date } {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dayStart = zonedWallToUtc(y, mo, d, 0, 0, tz);
  // Next local calendar day (UTC-date arithmetic on the date parts is safe).
  const next = new Date(Date.UTC(y, mo - 1, d) + 86_400_000);
  const dayEnd = zonedWallToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    tz,
  );
  return { dayStart, dayEnd };
}
