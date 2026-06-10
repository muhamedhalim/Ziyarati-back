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
} as const;

/** Period label stamped on dashboard metrics (snapshot scope). */
export const DASHBOARD_PERIOD = 'all_time';

/** A conversation counts as "active" if it had a message within this window. */
export const ACTIVE_CONVERSATION_WINDOW_DAYS = 7;

/** Round monetary/decimal values to 2 dp (avoids float drift in sums). */
export const round2 = (n: number): number => Math.round(Number(n) * 100) / 100;

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
  return { firstDay: `${monthStr}-01`, lastDay: lastDate.toISOString().slice(0, 10) };
}
