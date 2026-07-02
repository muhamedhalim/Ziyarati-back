/**
 * Usage status + alert primitives — the SINGLE place the "how full is this
 * quota?" thresholds live. Exported from the module so the notification system
 * (and anything else) can classify usage identically instead of re-deriving the
 * bands. Pure functions, no I/O.
 *
 * IMPORTANT: this file NEVER computes `used`/`limit`/`remaining`/`exceeded` — it
 * only classifies an already-computed line (from `UsageService.getBreakdown()`,
 * the single source of truth). It maps a percentage to a status band + colour.
 */

/** Status bands, mirroring the dashboard colour legend (PART 5). */
export const USAGE_STATUS = {
  NORMAL: 'normal', // green — below 80%
  WARNING: 'warning', // yellow — 80–95%
  CRITICAL: 'critical', // orange — 95–100%
  EXCEEDED: 'exceeded', // red — over the limit
  UNLIMITED: 'unlimited', // gray — no limit on the plan
} as const;

export type UsageStatus = (typeof USAGE_STATUS)[keyof typeof USAGE_STATUS];

/** A usage line as produced by `UsageService` (single source). */
export interface UsageLine {
  used: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  exceeded: boolean;
  unlimited?: boolean;
  /** Enforced AND exceeded — a write would be rejected at the quota gate. */
  blocked?: boolean;
}

/** Classify a usage line into a status band. Unlimited (limit === null) → gray. */
export function usageStatus(line: Pick<UsageLine, 'limit' | 'percentUsed' | 'exceeded'>): UsageStatus {
  if (line.limit === null || line.limit === undefined) return USAGE_STATUS.UNLIMITED;
  if (line.exceeded) return USAGE_STATUS.EXCEEDED;
  const pct = line.percentUsed ?? 0;
  if (pct >= 95) return USAGE_STATUS.CRITICAL;
  if (pct >= 80) return USAGE_STATUS.WARNING;
  return USAGE_STATUS.NORMAL;
}

/** Alert thresholds (PART 8). Ordered ascending; the highest crossed wins. */
export const USAGE_ALERT_THRESHOLDS = [80, 90, 95, 100] as const;

export type UsageAlertSeverity = 'info' | 'warning' | 'critical';

export interface UsageAlert {
  tenantId: string;
  tenantName?: string;
  /** Metric key, or a subscription-lifecycle pseudo-metric (see below). */
  metric: string;
  metricLabel: string;
  /** The crossed threshold (80/90/95/100) or 0 for lifecycle alerts. */
  threshold: number;
  percentUsed: number | null;
  used: number;
  limit: number | null;
  severity: UsageAlertSeverity;
  message: string;
  /** Quota is enforced AND exceeded (write blocked). */
  blocked?: boolean;
  /** ≥90% consumed — a plan upgrade is advisable. */
  recommendUpgrade?: boolean;
}

/**
 * Build quota-threshold alerts for a single metric line. Returns the single
 * highest crossed threshold (not one alert per band) so callers get one row per
 * (tenant, metric). Reusable by the notification system: the returned shape is
 * transport-agnostic.
 */
export function buildUsageAlert(
  ctx: { tenantId: string; tenantName?: string; metric: string; metricLabel: string },
  line: UsageLine,
): UsageAlert | null {
  if (line.limit === null || line.limit === undefined) return null; // unlimited → no quota alert
  const pct = line.percentUsed ?? 0;

  let crossed = 0;
  for (const t of USAGE_ALERT_THRESHOLDS) if (pct >= t) crossed = t;
  if (line.exceeded && crossed < 100) crossed = 100;
  if (crossed === 0) return null;

  const blocked = !!line.blocked;
  const severity: UsageAlertSeverity = crossed >= 95 || blocked ? 'critical' : 'warning';

  const message = blocked
    ? `${ctx.metricLabel} quota blocked (${line.used}/${line.limit}) — writes are being rejected`
    : line.exceeded
      ? `${ctx.metricLabel} quota exceeded (${line.used}/${line.limit})`
      : `${ctx.metricLabel} at ${pct}% of the plan limit (${line.used}/${line.limit})`;

  return {
    tenantId: ctx.tenantId,
    tenantName: ctx.tenantName,
    metric: ctx.metric,
    metricLabel: ctx.metricLabel,
    threshold: crossed,
    percentUsed: pct,
    used: line.used,
    limit: line.limit,
    severity,
    message,
    blocked,
    // ≥90% (but not yet blocked) → recommend an upgrade before it hard-stops.
    recommendUpgrade: crossed >= 90 && !blocked,
  };
}
