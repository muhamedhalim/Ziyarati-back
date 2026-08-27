/** Progress toward one target (appointments or revenue). */
export interface TargetMetricProgress {
  /** `null` = the owner has not set a target yet. */
  target: number | null;
  current: number;
  /** `max(target - current, 0)`; `null` when no target is set. */
  remaining: number | null;
  /** `current / target * 100`, rounded to 2dp; NOT capped at 100 — a caller
   *  rendering a progress bar should clamp it, but the raw figure (e.g. 133%)
   *  is meaningful on its own. `null` when no target is set. */
  percentage: number | null;
  isCompleted: boolean;
}

/**
 * Pure progress calculation — the single place every edge case called out
 * for the dashboard target cards is decided, so it can be unit-tested
 * without a database:
 *
 *  - `target` undefined/null → "no target set": everything else is `null`,
 *    never a divide-by-zero or a misleading 0%.
 *  - `target === 0` → trivially satisfied regardless of `current` (an owner
 *    who explicitly sets a target of 0 has already met it).
 *  - `current` may exceed `target` (target exceeded) — `percentage` is
 *    reported uncapped, `remaining` floors at 0, `isCompleted` is true.
 *  - `current === 0` with a positive target → 0%, not completed.
 */
export function computeMetricProgress(
  target: number | null | undefined,
  current: number,
): TargetMetricProgress {
  if (target === null || target === undefined) {
    return {
      target: null,
      current,
      remaining: null,
      percentage: null,
      isCompleted: false,
    };
  }

  if (target === 0) {
    return { target: 0, current, remaining: 0, percentage: 100, isCompleted: true };
  }

  return {
    target,
    current,
    remaining: Math.max(target - current, 0),
    percentage: Math.round((current / target) * 10000) / 100,
    isCompleted: current >= target,
  };
}
