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
