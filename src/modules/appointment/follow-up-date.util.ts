import { AppError, ErrorCode } from '../../common/errors';

/** How far ahead a clinician may schedule a follow-up. */
export const FOLLOW_UP_MAX_DAYS = 1095;

/** `YYYY-MM-DD` of `now` on the wall clock of `timeZone` (UTC when unknown). */
export function localDateIn(now: Date, timeZone?: string | null): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  try {
    return format(timeZone || 'UTC');
  } catch {
    return format('UTC');
  }
}

/** Milliseconds since epoch of a `YYYY-MM-DD` at 00:00 UTC; NaN when not a real date. */
export function dateOnlyEpoch(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // Date.UTC rolls 2026-02-31 into March; a real date round-trips unchanged.
  return back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d
    ? t
    : NaN;
}

/**
 * A follow-up date must be a real calendar date, not before the clinic's today and
 * not more than {@link FOLLOW_UP_MAX_DAYS} days away.
 */
export function assertFollowUpDate(
  dueOn: string,
  timeZone?: string | null,
  now: Date = new Date(),
): void {
  const due = dateOnlyEpoch(dueOn);
  if (Number.isNaN(due)) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: 'dueOn is not a valid calendar date',
    });
  }
  const today = dateOnlyEpoch(localDateIn(now, timeZone));
  if (due < today) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: 'The follow-up date cannot be in the past',
    });
  }
  if (due - today > FOLLOW_UP_MAX_DAYS * 86_400_000) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: 'The follow-up date is too far ahead',
    });
  }
}
