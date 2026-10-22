/**
 * Per-IP throttle ceiling for `PublicPlansController`'s anonymous route. The
 * marketing site loads this once per `/pricing` visit, so the platform-wide
 * 300/min default is far more than a visitor needs; this is the same ceiling
 * as the other small public catalogue reads (`public-discovery.throttle.ts`).
 */
export const PUBLIC_PLANS_LIMIT = 60;

export const PUBLIC_PLANS_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : PUBLIC_PLANS_LIMIT,
    ttl: 60_000,
  },
};
