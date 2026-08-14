import {
  COMPARISON_STATE,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  MAX_SERIES_POINTS,
  METRIC_DIRECTION,
  type ComparisonState,
} from './dashboard.constants';
import type { QueryDashboardRangeDto } from './dto/query-dashboard-range.dto';
import { AppError, ErrorCode } from '../../common/errors';

const DAY_MS = 86_400_000;

export interface ResolvedRange {
  /** Inclusive lower bound. */
  from: Date;
  /** EXCLUSIVE upper bound — windows are half-open so no row lands in two. */
  to: Date;
  /** Same-length window immediately before `from`. */
  previousFrom: Date;
  previousTo: Date;
  /** Bucket width for trend series. */
  bucket: 'day' | 'week' | 'month';
  timezone: 'UTC';
}

/** Start of the UTC day containing `d`. Never `date_trunc` in SQL — see DASHBOARD_TIMEZONE. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Turns the request into a concrete UTC window plus its comparison window.
 *
 * Every boundary is computed HERE, in JS, and bound as a query parameter. The
 * alternative — `date_trunc('day', now())` in SQL — silently follows whatever
 * timezone the Postgres server is configured with, which is exactly how
 * `MarketplaceFinanceService.kpis()` and its own drill-down came to disagree
 * about when "today" starts.
 */
export function resolveRange(q: QueryDashboardRangeDto, now = new Date()): ResolvedRange {
  let from: Date;
  let to: Date;

  if (q.from && q.to) {
    from = new Date(q.from);
    to = new Date(q.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Invalid `from` / `to` timestamp',
      });
    }
    if (to <= from) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: '`to` must be after `from`',
      });
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Range must not exceed ${MAX_RANGE_DAYS} days`,
      });
    }
  } else {
    // `to` is "now", not end-of-day: a period metric should include what
    // happened five minutes ago, and a half-open bound makes that exact.
    to = now;
    const days =
      q.range === 'today'
        ? null
        : q.range === '7d'
          ? 7
          : q.range === '90d'
            ? 90
            : q.range === '30d'
              ? 30
              : DEFAULT_RANGE_DAYS;
    from = days === null ? startOfUtcDay(now) : new Date(now.getTime() - days * DAY_MS);
  }

  const span = to.getTime() - from.getTime();
  const spanDays = span / DAY_MS;

  return {
    from,
    to,
    previousFrom: new Date(from.getTime() - span),
    previousTo: from,
    // Keeps a 366-day range from returning 366 points. Bucket choice is about
    // legibility, not cost: a year of daily bars is unreadable long before it
    // is slow.
    bucket:
      spanDays <= MAX_SERIES_POINTS
        ? 'day'
        : spanDays <= MAX_SERIES_POINTS * 7
          ? 'week'
          : 'month',
    timezone: 'UTC',
  };
}

export interface Comparison {
  current: number;
  previous: number;
  delta: number;
  /** Null whenever a percentage would be undefined or misleading. */
  percent: number | null;
  state: ComparisonState;
  direction: (typeof METRIC_DIRECTION)[string];
}

/**
 * Builds a comparison, refusing to invent a percentage.
 *
 * A zero denominator is the case that produces "+100%" or "+∞%" on careless
 * dashboards. Here it is `NEW` (something where there was nothing) or `NONE`
 * (nothing either way) — both distinguishable by the client, neither dressed up
 * as a rate. `direction` travels with the number so the UI colours a rise in
 * failed payments red without having to know that rule itself.
 */
export function compare(
  metric: string,
  current: number,
  previous: number,
  hasBaseline = true,
): Comparison {
  const direction = METRIC_DIRECTION[metric] ?? 'higher-is-better';
  const delta = round2(current - previous);

  if (!hasBaseline) {
    return { current, previous, delta, percent: null, state: COMPARISON_STATE.NO_BASELINE, direction };
  }
  if (previous === 0) {
    return current === 0
      ? { current, previous, delta, percent: null, state: COMPARISON_STATE.NONE, direction }
      : { current, previous, delta, percent: null, state: COMPARISON_STATE.NEW, direction };
  }
  return {
    current,
    previous,
    delta,
    percent: Math.round(((current - previous) / previous) * 1000) / 10,
    state: COMPARISON_STATE.CHANGED,
    direction,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Postgres `to_char` format per bucket — labels are stable, sortable strings. */
export const BUCKET_FORMAT: Record<ResolvedRange['bucket'], string> = {
  day: 'YYYY-MM-DD',
  week: 'IYYY-"W"IW',
  month: 'YYYY-MM',
};
