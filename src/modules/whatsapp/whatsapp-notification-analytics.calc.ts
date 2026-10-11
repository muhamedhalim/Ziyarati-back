/**
 * Pure calculations behind the Notifications → Analytics tab. No I/O here, so
 * every ratio, comparison and alert rule is unit-testable without a database.
 *
 * COHORT. A "notification" is one `scheduled_notifications` row whose
 * template's configured channel is WHATSAPP, placed in a period by its
 * `scheduled_at` (when it was due — NOT when it was created, and not once per
 * send attempt). One row = one notification, so a retried or rescheduled send
 * is counted once.
 *
 * RATIOS. Every ratio carries an explicit denominator and is `null` — never
 * 0, never NaN — when that denominator is 0, so the UI can say "no data" rather
 * than show a misleading 0% or 100%.
 */

export const ANALYTICS_RANGES = ['7d', '30d', '90d'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = '30d';

const RANGE_DAYS: Record<AnalyticsRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};
const DAY_MS = 24 * 60 * 60 * 1000;

/** A send whose delivery receipt is still allowed to be in flight. */
export const DELIVERY_CONFIRMATION_GRACE_MS = DAY_MS;

/** Below this many resolved notifications a failure RATE is too noisy to alert on. */
export const MIN_SAMPLE_FOR_ALERT = 20;
export const HIGH_FAILURE_RATE_PERCENT = 10;
export const UNCONFIRMED_DELIVERY_SHARE_PERCENT = 50;

export interface PeriodWindow {
  from: Date;
  to: Date;
}

export interface AnalyticsWindows {
  current: PeriodWindow;
  /** Same length as `current`, ending exactly where `current` starts. */
  previous: PeriodWindow;
}

/**
 * `current` is the last N days up to `now` (future-dated rows are therefore
 * excluded — they are not outcomes yet); `previous` is the N days before it.
 * Equal lengths and adjacent edges are what make the comparison like-for-like.
 */
export function resolveWindows(
  range: AnalyticsRange,
  now: Date,
): AnalyticsWindows {
  const span = RANGE_DAYS[range] * DAY_MS;
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - span);
  const prevFrom = new Date(from.getTime() - span);
  return { current: { from, to }, previous: { from: prevFrom, to: from } };
}

export interface PeriodCounts {
  /** Everything due in the period (any status). */
  total: number;
  /** Not yet resolved: PENDING / SCHEDULED / PROCESSING. */
  pending: number;
  cancelled: number;
  /** The provider accepted the message (`SENT`, plus the legacy `DELIVERED`). */
  sent: number;
  failed: number;
  /** Send phase entered, outcome unknown (SEND_UNCERTAIN). */
  uncertain: number;
  /** Sent AND actually carried by WhatsApp (not an email fallback). */
  whatsappSent: number;
  /** WhatsApp was requested but the email fallback carried it. */
  emailFallback: number;
  /** WhatsApp sends confirmed delivered (includes READ). */
  delivered: number;
  read: number;
  /** WhatsApp sends the carrier reported as failed AFTER acceptance. */
  carrierFailed: number;
  /** WhatsApp sends with no delivery receipt yet. */
  awaitingConfirmation: number;
  /** WhatsApp sends older than the grace window … */
  matureWhatsappSent: number;
  /** … and still without a delivered/read/failed receipt. */
  matureUnconfirmed: number;
}

export const EMPTY_COUNTS: PeriodCounts = Object.freeze({
  total: 0,
  pending: 0,
  cancelled: 0,
  sent: 0,
  failed: 0,
  uncertain: 0,
  whatsappSent: 0,
  emailFallback: 0,
  delivered: 0,
  read: 0,
  carrierFailed: 0,
  awaitingConfirmation: 0,
  matureWhatsappSent: 0,
  matureUnconfirmed: 0,
}) as PeriodCounts;

const toCount = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/** Coerces a raw SQL row (counts arrive as strings from pg) into counts. */
export function toCounts(
  row: Record<string, unknown> | undefined | null,
): PeriodCounts {
  const out = { ...EMPTY_COUNTS };
  if (!row) return out;
  for (const key of Object.keys(out) as (keyof PeriodCounts)[]) {
    out[key] = toCount(row[key]);
  }
  return out;
}

/** Percent with one decimal, or `null` when there is nothing to divide by. */
export function percent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  const raw = (numerator / denominator) * 100;
  return Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
}

export interface PeriodRates {
  /** sent / resolved */
  successRate: number | null;
  /** failed / resolved */
  failureRate: number | null;
  /** delivered(+read) / whatsappSent */
  deliveryRate: number | null;
  /** read / delivered */
  readRate: number | null;
}

export interface RateDenominators {
  /** sent + failed + uncertain — what has actually reached an outcome. */
  resolved: number;
  whatsappSent: number;
  delivered: number;
}

export function computeRates(c: PeriodCounts): {
  rates: PeriodRates;
  denominators: RateDenominators;
} {
  const resolved = c.sent + c.failed + c.uncertain;
  return {
    denominators: {
      resolved,
      whatsappSent: c.whatsappSent,
      delivered: c.delivered,
    },
    rates: {
      successRate: percent(c.sent, resolved),
      failureRate: percent(c.failed, resolved),
      deliveryRate: percent(c.delivered, c.whatsappSent),
      readRate: percent(c.read, c.delivered),
    },
  };
}

export interface CountComparison {
  current: number;
  previous: number;
  absolute: number;
  /** `null` when there was no previous value to take a percentage of. */
  percent: number | null;
  /** `new` = something where there was nothing; `none` = nothing either way. */
  state: 'changed' | 'new' | 'none';
}

export function compareCount(
  current: number,
  previous: number,
): CountComparison {
  const absolute = current - previous;
  if (previous === 0) {
    return {
      current,
      previous,
      absolute,
      percent: null,
      state: current === 0 ? 'none' : 'new',
    };
  }
  return {
    current,
    previous,
    absolute,
    percent: Math.round((absolute / previous) * 1000) / 10,
    state: 'changed',
  };
}

export interface RateComparison {
  current: number | null;
  previous: number | null;
  /** Percentage-point difference; `null` unless BOTH periods have a rate. */
  points: number | null;
}

export function compareRate(
  current: number | null,
  previous: number | null,
): RateComparison {
  const points =
    current === null || previous === null
      ? null
      : Math.round((current - previous) * 10) / 10;
  return { current, previous, points };
}

/**
 * Bounded failure categories. The raw `failure_reason` text is never exposed:
 * it can echo provider detail, and the UI localises by code instead.
 */
export const FAILURE_REASON_CODES = [
  'OPTED_OUT',
  'QUOTA_EXHAUSTED',
  'UNREACHABLE',
  'RECIPIENT_NOT_FOUND',
  'INVALID_RECIPIENT',
  'NO_PROVIDER',
  'TEMPLATE_VARIABLES',
  'PROVIDER_ERROR',
  'DUPLICATE_PREVENTED',
  'SEND_UNCERTAIN',
  'OTHER',
] as const;
export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number];

export function normalizeFailureCode(code: unknown): FailureReasonCode {
  return (FAILURE_REASON_CODES as readonly string[]).includes(String(code))
    ? (code as FailureReasonCode)
    : 'OTHER';
}

export interface FailureReasonRow {
  code: FailureReasonCode;
  count: number;
  /** Share of all unsuccessful (failed + uncertain) notifications. */
  sharePercent: number | null;
}

/** Merges rows that normalise to the same code and ranks them. */
export function buildFailureReasons(
  rows: Array<{ code: unknown; count: unknown }>,
): FailureReasonRow[] {
  const merged = new Map<FailureReasonCode, number>();
  for (const r of rows) {
    const code = normalizeFailureCode(r.code);
    merged.set(code, (merged.get(code) ?? 0) + toCount(r.count));
  }
  const total = [...merged.values()].reduce((a, b) => a + b, 0);
  return [...merged.entries()]
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({
      code,
      count,
      sharePercent: percent(count, total),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export type AnalyticsAlertCode =
  | 'HIGH_FAILURE_RATE'
  | 'SEND_UNCERTAIN'
  | 'QUOTA_EXHAUSTED'
  | 'NO_DELIVERY_CONFIRMATION';

export interface AnalyticsAlert {
  code: AnalyticsAlertCode;
  severity: 'warning' | 'critical';
  /** The figure the alert is about (a count, or a percent for rate alerts). */
  value: number;
}

/** Only actionable, evidence-backed conditions — each has a minimum sample. */
export function buildAlerts(
  counts: PeriodCounts,
  reasons: FailureReasonRow[],
): AnalyticsAlert[] {
  const alerts: AnalyticsAlert[] = [];
  const { rates, denominators } = computeRates(counts);

  if (
    denominators.resolved >= MIN_SAMPLE_FOR_ALERT &&
    rates.failureRate !== null &&
    rates.failureRate >= HIGH_FAILURE_RATE_PERCENT
  ) {
    alerts.push({
      code: 'HIGH_FAILURE_RATE',
      severity: 'critical',
      value: rates.failureRate,
    });
  }

  const quota = reasons.find((r) => r.code === 'QUOTA_EXHAUSTED');
  if (quota && quota.count > 0) {
    alerts.push({
      code: 'QUOTA_EXHAUSTED',
      severity: 'critical',
      value: quota.count,
    });
  }

  if (counts.uncertain > 0) {
    alerts.push({
      code: 'SEND_UNCERTAIN',
      severity: 'warning',
      value: counts.uncertain,
    });
  }

  const unconfirmed = percent(
    counts.matureUnconfirmed,
    counts.matureWhatsappSent,
  );
  if (
    counts.matureWhatsappSent >= MIN_SAMPLE_FOR_ALERT &&
    unconfirmed !== null &&
    unconfirmed >= UNCONFIRMED_DELIVERY_SHARE_PERCENT
  ) {
    alerts.push({
      code: 'NO_DELIVERY_CONFIRMATION',
      severity: 'warning',
      value: unconfirmed,
    });
  }

  return alerts;
}

/** A tenant timezone is only used if Intl recognises it; otherwise UTC. */
export function safeTimeZone(candidate: string | null | undefined): string {
  if (!candidate) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}
