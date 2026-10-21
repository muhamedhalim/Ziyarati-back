/**
 * Analytics domain constants + pure date helpers.
 *
 * Aggregation is performed on UTC day/month boundaries for determinism (the
 * frozen entities store no per-row timezone for events/payments). Branch-level
 * timezone handling is intentionally out of scope to avoid schema assumptions.
 */

/** Dashboard KPI keys (stored in DashboardMetric.metric_key). */
export const METRIC_KEY = {
  TOTAL_CUSTOMERS: 'total_customers',
  TOTAL_APPOINTMENTS: 'total_appointments',
  TOTAL_REVENUE: 'total_revenue',
  TOTAL_PAID_PAYMENTS: 'total_paid_payments',
  ACTIVE_CONVERSATIONS: 'active_conversations',
  AI_MESSAGES: 'ai_messages',
  AI_TOKENS_USED: 'ai_tokens_used',
  TOTAL_NO_SHOWS: 'total_no_shows',
  /** Tenant-wide appointment counts grouped by `Appointment.source`. */
  BOOKINGS_PLATFORM: 'bookings_platform',
  BOOKINGS_WHATSAPP_BOT: 'bookings_whatsapp_bot',
  BOOKINGS_MANUAL: 'bookings_manual',
  BOOKINGS_PUBLIC_AI: 'bookings_public_ai',
} as const;

/** The 4 booking-source metric keys, in display order, mapped from {@link AppointmentSource}. */
export const BOOKING_SOURCE_METRIC_KEY: Record<string, string> = {
  PLATFORM: METRIC_KEY.BOOKINGS_PLATFORM,
  WHATSAPP_BOT: METRIC_KEY.BOOKINGS_WHATSAPP_BOT,
  MANUAL: METRIC_KEY.BOOKINGS_MANUAL,
  PUBLIC_AI: METRIC_KEY.BOOKINGS_PUBLIC_AI,
};

/** Period label stamped on dashboard metrics (snapshot scope). */
export const DASHBOARD_PERIOD = 'all_time';

/** A conversation counts as "active" if it had a message within this window. */
export const ACTIVE_CONVERSATION_WINDOW_DAYS = 7;

/**
 * Spec 014 (Clinic Platform Completion) — T146 (US11, contracts/clinic-
 * surfaces.md §F11: "from, to (required, bounded)"). The widest `[from, to]`
 * an advanced-analytics request may span — just over 2 years, matching the
 * SC-033 performance budget's own range (2-year / 100k-appointment query
 * under 3s), so the one range the perf test proves is fast is also the
 * widest one a caller can ever actually request.
 */
export const MAX_ADVANCED_ANALYTICS_RANGE_DAYS = 731;

/** Round monetary/decimal values to 2 dp (avoids float drift in sums). */
export const round2 = (n: number): number => Math.round(Number(n) * 100) / 100;

/**
 * Round a 0..1 ratio to 4 dp — keeps one decimal of a percentage exact
 * (0.6667 → 66.7%). `round2` on a ratio silently truncates to whole percents.
 */
export const roundRatio = (n: number): number =>
  Math.round(Number(n) * 10_000) / 10_000;

/**
 * ── DATE STRATEGY (single source of truth) ──────────────────────────────────
 * Calendar report values are STRINGS, never JS `Date` objects:
 *   • daily report `date`            → 'YYYY-MM-DD'  (ReportDate)
 *   • monthly report `period_month`  → 'YYYY-MM'     (ReportMonth)
 * JS `Date` objects are used ONLY for timestamptz range bounds (created_at /
 * paid_at / start_at / last_message_at), produced exclusively by
 * `dayRangeUtc()` / `monthRangeUtc()` below.
 *
 * The frozen `DailyReport` entity mistypes its Postgres `date` column as `Date`,
 * but that column round-trips through TypeORM as a 'YYYY-MM-DD' STRING at
 * runtime. `reportDateColumn()` is the ONE sanctioned boundary cast that
 * reconciles the runtime string with the entity's declared type — it replaces
 * the previously scattered `dateStr as unknown as Date` / `as any` casts.
 */
export type ReportDate = string; // 'YYYY-MM-DD'
export type ReportMonth = string; // 'YYYY-MM'

/** The single sanctioned cast at the frozen-entity boundary (see note above). */
export function reportDateColumn(dateStr: ReportDate): Date {
  return dateStr as unknown as Date;
}

/** Inclusive UTC day range [00:00:00.000, 23:59:59.999] for a 'YYYY-MM-DD'. */
export function dayRangeUtc(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000 - 1);
  return { start, end };
}

/** Inclusive UTC month range for a 'YYYY-MM'. */
export function monthRangeUtc(monthStr: string): { start: Date; end: Date } {
  const start = new Date(`${monthStr}-01T00:00:00.000Z`);
  const nextMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  const end = new Date(nextMonth.getTime() - 1);
  return { start, end };
}

/** First/last calendar day ('YYYY-MM-DD') of a month — for the DATE column filter. */
export function monthDateBounds(monthStr: string): {
  firstDay: string;
  lastDay: string;
} {
  const start = new Date(`${monthStr}-01T00:00:00.000Z`);
  const lastDate = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  );
  return {
    firstDay: `${monthStr}-01`,
    lastDay: lastDate.toISOString().slice(0, 10),
  };
}

/**
 * Spec 014 (Clinic Platform Completion) — T145 (US11). Inclusive day count
 * between two 'YYYY-MM-DD' strings (both UTC calendar days) — the single
 * place range LENGTH is computed, so the bound check (T146) and the "prior
 * period" derivation (FR-A007) always agree on what "N days" means.
 */
export function inclusiveDayCount(from: ReportDate, to: ReportDate): number {
  const startMs = dayRangeUtc(from).start.getTime();
  const endMs = dayRangeUtc(to).start.getTime();
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

/**
 * Every UTC calendar day in the inclusive [from, to] range, as 'YYYY-MM-DD'
 * strings — the fixed day list a trend series is filled against so a day
 * with zero appointments still appears as a real `0`, never a silently
 * missing bucket (distinct from the whole-range "empty" case, FR-A020).
 */
export function enumerateDays(from: ReportDate, to: ReportDate): ReportDate[] {
  const days: ReportDate[] = [];
  const start = dayRangeUtc(from).start;
  const count = inclusiveDayCount(from, to);
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Spec 014 (Clinic Platform Completion) — T145 (US11, FR-A007). The "earlier
 * period" retention is measured against: the SAME number of calendar days,
 * immediately preceding `from` (so [priorFrom, priorTo] and [from, to] are
 * adjacent, non-overlapping, and equal length).
 */
export function priorPeriod(
  from: ReportDate,
  to: ReportDate,
): { priorFrom: ReportDate; priorTo: ReportDate } {
  const lengthDays = inclusiveDayCount(from, to);
  const fromStart = dayRangeUtc(from).start;
  const priorToDate = new Date(fromStart.getTime() - 86_400_000);
  const priorFromDate = new Date(fromStart.getTime() - lengthDays * 86_400_000);
  return {
    priorFrom: priorFromDate.toISOString().slice(0, 10),
    priorTo: priorToDate.toISOString().slice(0, 10),
  };
}

/**
 * The calendar month immediately before `now`, in UTC, as `'YYYY-MM'`
 * (FND-014). Explicit UTC arithmetic (never `getMonth()`/`getFullYear()`,
 * which read the server's local timezone) so the scheduled monthly-report
 * sweep — which fires just after month rollover to report on the month that
 * just ended — targets the same month regardless of the worker host's TZ.
 */
export function previousMonthUtc(now: Date = new Date()): ReportMonth {
  const prev = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The CURRENT calendar month, in UTC, as `'YYYY-MM'`. Used by the dashboard
 * target-tracking cards, which — unlike the monthly report sweep — always
 * report on the month still in progress, never the one that just ended.
 */
export function currentMonthUtc(now: Date = new Date()): ReportMonth {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ──────────────────────── Clinic-local calendar days ──────────────────────── //
//
// Audit 2026-10-21: every report day/month used to be a UTC calendar day, so
// for a Riyadh clinic (UTC+3) anything between 00:00 and 03:00 local landed
// on the previous day. Report days and months are now the clinic's own
// calendar days in its reporting timezone (see
// `AnalyticsAggregationService.resolveReportingTimezone`). The helpers below
// are the zone-aware twins of `dayRangeUtc` / `monthRangeUtc`; with
// `tz = 'UTC'` they return exactly what those return.

export const DEFAULT_REPORTING_TIMEZONE = 'UTC';

/** True when `tz` is an IANA zone name the runtime (and Postgres) understands. */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `tz`'s offset from UTC at `instant`, in ms (positive east of Greenwich). */
function zoneOffsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of local midnight starting 'YYYY-MM-DD' in `tz` (DST-safe). */
function zonedMidnight(dateStr: string, tz: string): number {
  const naive = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  let guess = naive - zoneOffsetMs(naive, tz);
  // A second pass settles days where the offset changes (DST transitions).
  guess = naive - zoneOffsetMs(guess, tz);
  return guess;
}

/** 'YYYY-MM-DD' one calendar day after `dateStr` (pure calendar arithmetic). */
function nextDay(dateStr: string): string {
  return new Date(dayRangeUtc(dateStr).start.getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Inclusive instant range of local calendar day 'YYYY-MM-DD' in `tz`. */
export function dayRangeInZone(
  dateStr: string,
  tz: string,
): { start: Date; end: Date } {
  return {
    start: new Date(zonedMidnight(dateStr, tz)),
    end: new Date(zonedMidnight(nextDay(dateStr), tz) - 1),
  };
}

/** Inclusive instant range of local calendar month 'YYYY-MM' in `tz`. */
export function monthRangeInZone(
  monthStr: string,
  tz: string,
): { start: Date; end: Date } {
  const { firstDay, lastDay } = monthDateBounds(monthStr);
  return {
    start: dayRangeInZone(firstDay, tz).start,
    end: dayRangeInZone(lastDay, tz).end,
  };
}

/** The local calendar date ('YYYY-MM-DD') of `now` in `tz`. */
export function todayInZone(tz: string, now: Date = new Date()): ReportDate {
  return new Date(now.getTime() + zoneOffsetMs(now.getTime(), tz))
    .toISOString()
    .slice(0, 10);
}

/** The local calendar day before `now`'s in `tz` — a day that has fully ended. */
export function yesterdayInZone(
  tz: string,
  now: Date = new Date(),
): ReportDate {
  const today = todayInZone(tz, now);
  return new Date(dayRangeUtc(today).start.getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The local calendar month in progress at `now` in `tz`, as 'YYYY-MM'. */
export function currentMonthInZone(
  tz: string,
  now: Date = new Date(),
): ReportMonth {
  return todayInZone(tz, now).slice(0, 7);
}

/** The local calendar month before the one in progress at `now` in `tz`. */
export function previousMonthInZone(
  tz: string,
  now: Date = new Date(),
): ReportMonth {
  const [y, m] = currentMonthInZone(tz, now).split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}
