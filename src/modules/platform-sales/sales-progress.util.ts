import { computeMetricProgress } from '../tenant/tenant-target-progress.util';

import { AppError, ErrorCode } from '../../common/errors';
import {
  currentSalesPeriod,
  parseSalesPeriod,
  salesPeriodOf,
} from './sales-period.util';
import type { SalesPeriod } from './sales-period.util';
import { SALES_TARGET_RANGE_MAX_MONTHS } from './platform-sales.constants';

/** Where a month sits relative to now. */
export type SalesPhase = 'past' | 'current' | 'future';

export function salesPhaseOf(
  period: SalesPeriod,
  now: Date = new Date(),
): SalesPhase {
  const cur = currentSalesPeriod(now);
  if (period.end.getTime() <= cur.start.getTime()) return 'past';
  if (period.start.getTime() >= cur.end.getTime()) return 'future';
  return 'current';
}

/**
 * How far through the month we are, as a percentage: what an employee "should"
 * have achieved by now if progress were linear. A closed month expects 100, a
 * month that has not started expects 0.
 */
export function expectedPercentage(
  period: SalesPeriod,
  now: Date = new Date(),
): number {
  const phase = salesPhaseOf(period, now);
  if (phase === 'past') return 100;
  if (phase === 'future') return 0;
  const span = period.end.getTime() - period.start.getTime();
  const elapsed = now.getTime() - period.start.getTime();
  return Math.round((elapsed / span) * 10000) / 100;
}

export interface SalesProgress {
  target: number | null;
  achieved: number;
  remaining: number | null;
  /** Uncapped (133 means 133 %); `null` when no target is set. */
  percentage: number | null;
  isCompleted: boolean;
  /** Linear pace for this month, 0–100. */
  expectedPercentage: number;
  /**
   * Whether progress is at least at pace. `null` when there is no target. A
   * closed month is "on track" only when the target was reached.
   */
  onTrack: boolean | null;
}

/**
 * Progress of one metric. Delegates the target/percentage edge cases (no
 * target, target 0, exceeded) to `computeMetricProgress` — the same function
 * the clinic dashboard uses — and adds the pace comparison on top.
 */
export function salesProgress(
  target: number | null,
  achieved: number,
  period: SalesPeriod,
  now: Date = new Date(),
): SalesProgress {
  const p = computeMetricProgress(target, achieved);
  const expected = expectedPercentage(period, now);
  const phase = salesPhaseOf(period, now);
  let onTrack: boolean | null = null;
  if (p.percentage !== null) {
    onTrack = phase === 'past' ? p.isCompleted : p.percentage >= expected;
  }
  return {
    target: p.target,
    achieved,
    remaining: p.remaining,
    percentage: p.percentage,
    isCompleted: p.isCompleted,
    expectedPercentage: expected,
    onTrack,
  };
}

/** Every month from `from` to `to` inclusive, oldest first. */
export function salesPeriodsBetween(from: string, to: string): SalesPeriod[] {
  const a = parseSalesPeriod(from);
  const b = parseSalesPeriod(to);
  if (a.start.getTime() > b.start.getTime()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: '`from` must not be after `to`',
      publicContext: { field: 'from' },
    });
  }
  const out: SalesPeriod[] = [];
  let cursor = a.start;
  while (cursor.getTime() <= b.start.getTime()) {
    out.push(parseSalesPeriod(salesPeriodOf(cursor)));
    if (out.length > SALES_TARGET_RANGE_MAX_MONTHS) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `A range may cover at most ${SALES_TARGET_RANGE_MAX_MONTHS} months`,
        publicContext: { field: 'to' },
      });
    }
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
  }
  return out;
}
