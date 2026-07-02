/**
 * Usage forecasting + overage-cost projection — pure, reusable, no I/O.
 *
 * Forecasting NEVER invents usage: it takes an already-resolved usage line (from
 * `UsageService.getUnifiedBreakdown`, the single source) plus an
 * `avgDailyGrowth` derived from HISTORICAL data by the caller, and projects a
 * linear exhaustion date. Overage-cost projection is delegated to a pluggable
 * pricing strategy so prices are never hardcoded here.
 */

export interface ForecastInput {
  used: number;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
  /** Average daily consumption from history (rows/bytes per day). Null = unknown. */
  avgDailyGrowth: number | null;
}

export interface UsageForecast {
  avgDailyGrowth: number | null;
  /** Whole days until the limit is reached (0 if already at/over). Null = n/a. */
  estimatedDaysToFull: number | null;
  /** ISO date the limit is projected to be hit. Null = n/a. */
  estimatedFullDate: string | null;
  /** True when a finite limit will be reached given positive growth. */
  willExhaust: boolean;
}

/** Linear projection: daysToFull = remaining / avgDailyGrowth. */
export function computeForecast(input: ForecastInput, now: Date = new Date()): UsageForecast {
  const none: UsageForecast = {
    avgDailyGrowth: input.avgDailyGrowth,
    estimatedDaysToFull: null,
    estimatedFullDate: null,
    willExhaust: false,
  };
  if (input.unlimited || input.limit === null) return none;
  if (input.avgDailyGrowth === null || input.avgDailyGrowth <= 0) {
    // Already exceeded with no growth signal still counts as exhausted.
    return { ...none, estimatedDaysToFull: input.remaining !== null && input.remaining <= 0 ? 0 : null };
  }
  const remaining = Math.max(input.remaining ?? Math.max(input.limit - input.used, 0), 0);
  const days = Math.floor(remaining / input.avgDailyGrowth);
  const full = new Date(now.getTime() + days * 86_400_000);
  return {
    avgDailyGrowth: input.avgDailyGrowth,
    estimatedDaysToFull: days,
    estimatedFullDate: full.toISOString(),
    willExhaust: true,
  };
}

/** Days elapsed in the current UTC month (>=1) — used for the period-rate fallback. */
export function daysElapsedInMonth(now: Date = new Date()): number {
  return Math.max(now.getUTCDate(), 1);
}

// ─────────────────────── Overage cost projection (pluggable) ──────────────── //

/** Injection token for the overage pricing strategy. */
export const OVERAGE_PRICING = Symbol('OVERAGE_PRICING');

export interface OverageProjection {
  /** Units over the limit (0 when within limit / unlimited). */
  overageUnits: number;
  /** Projected cost in the platform currency, or null when pricing is inactive. */
  projectedCost: number | null;
  currency: string;
  /** Whether an active pricing strategy produced the cost. */
  active: boolean;
}

/**
 * Strategy that turns a metric's overage into a projected cost. Implementations
 * own their price book — NO price is ever hardcoded in the dashboard. The default
 * (`NoopOveragePricing`) reports inactive so the UI can render "not billed yet"
 * while the architecture is ready for a real pricing plug-in later.
 */
export interface OveragePricingStrategy {
  readonly active: boolean;
  readonly currency: string;
  /** Project the cost of `overageUnits` of `metric`. Return null cost if inactive. */
  project(metric: string, overageUnits: number): OverageProjection;
}
