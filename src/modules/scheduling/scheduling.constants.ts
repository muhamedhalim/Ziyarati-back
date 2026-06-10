import { AppointmentStatus } from '../../entities/enums';

/**
 * Scheduling domain constants + pure helpers for the availability engine.
 *
 * Availability is computed on concrete datetime windows (the CalendarSlot /
 * BlockedSlot entities store `start_time`/`end_time` timestamptz — there are NO
 * recurrence fields in the schema, so no day-of-week recurrence is assumed).
 * Day-level math uses UTC boundaries for determinism.
 */

/** Appointment statuses that OCCUPY a time window (block double-booking). */
export const OCCUPYING_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING_PAYMENT,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.COMPLETED,
];

export interface Interval {
  start: Date;
  end: Date;
}

/** Inclusive-start / exclusive-end UTC day bounds for a 'YYYY-MM-DD'. */
export function dayBoundsUtc(dateStr: string): { dayStart: Date; dayEnd: Date } {
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  return { dayStart, dayEnd };
}

/** 'YYYY-MM-DD' for a Date (UTC) or pass-through for an already-string date. */
export function toYmd(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export const maxDate = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);
export const minDate = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

/** Two half-open intervals overlap iff a.start < b.end && b.start < a.end. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** Free sub-intervals of `slot` after removing `busy` intervals (clamped to slot). */
export function subtractIntervals(slot: Interval, busy: Interval[]): Interval[] {
  const slotStart = slot.start.getTime();
  const slotEnd = slot.end.getTime();
  if (slotEnd <= slotStart) return [];

  const clamped = busy
    .map((b) => ({
      s: Math.max(b.start.getTime(), slotStart),
      e: Math.min(b.end.getTime(), slotEnd),
    }))
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);

  const result: Interval[] = [];
  let cursor = slotStart;
  for (const b of clamped) {
    if (b.s > cursor) result.push({ start: new Date(cursor), end: new Date(b.s) });
    cursor = Math.max(cursor, b.e);
  }
  if (cursor < slotEnd) result.push({ start: new Date(cursor), end: new Date(slotEnd) });
  return result;
}

/** Merge overlapping/adjacent intervals into a minimal sorted set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start.getTime() <= last.end.getTime()) {
      if (sorted[i].end.getTime() > last.end.getTime()) last.end = sorted[i].end;
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/** Split free intervals into fixed-length bookable slots (drops remainders). */
export function chunkIntervals(intervals: Interval[], minutes: number): Interval[] {
  const ms = minutes * 60_000;
  const out: Interval[] = [];
  for (const iv of intervals) {
    let s = iv.start.getTime();
    while (s + ms <= iv.end.getTime()) {
      out.push({ start: new Date(s), end: new Date(s + ms) });
      s += ms;
    }
  }
  return out;
}

/** Total minutes across a set of intervals. */
export function totalMinutes(intervals: Interval[]): number {
  return Math.round(
    intervals.reduce((sum, iv) => sum + (iv.end.getTime() - iv.start.getTime()), 0) /
      60_000,
  );
}
