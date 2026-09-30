import { AppError, ErrorCode } from '../../common/errors';

/**
 * Sales periods are UTC CALENDAR MONTHS, addressed as `YYYY-MM`.
 *
 * Boundaries are always computed from UTC components and handed to SQL as ISO
 * instants — never derived from the host's local time. (The dev host runs at
 * UTC+3 while the database stores UTC; local-time month maths would put a
 * payment made late on the last day in the wrong month.)
 */
export interface SalesPeriod {
  /** 'YYYY-MM' */
  period: string;
  /** 'YYYY-MM-01' — the value stored in `sales_targets.period_month`. */
  periodMonth: string;
  /** Inclusive lower bound. */
  start: Date;
  /** EXCLUSIVE upper bound (first instant of the next month). */
  end: Date;
  daysInMonth: number;
}

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseSalesPeriod(period: string): SalesPeriod {
  const m = PERIOD_RE.exec(period);
  if (!m) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'period must be a month in the form YYYY-MM',
      publicContext: { field: 'period' },
    });
  }
  const year = Number(m[1]);
  const month = Number(m[2]); // 1..12
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    period,
    periodMonth: `${m[1]}-${m[2]}-01`,
    start,
    end,
    daysInMonth: Math.round((end.getTime() - start.getTime()) / 86_400_000),
  };
}

/** `YYYY-MM` of an instant, in UTC. */
export function salesPeriodOf(instant: Date): string {
  const y = instant.getUTCFullYear();
  const m = String(instant.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** The period containing `now` (injectable for tests). */
export function currentSalesPeriod(now: Date = new Date()): SalesPeriod {
  return parseSalesPeriod(salesPeriodOf(now));
}

/** The period is strictly before the one containing `now` — i.e. fully closed. */
export function isPastSalesPeriod(
  period: SalesPeriod,
  now: Date = new Date(),
): boolean {
  return period.end.getTime() <= currentSalesPeriod(now).start.getTime();
}
