/**
 * Tighter ceiling for the two routes that call the payment provider per request
 * (opening a hosted checkout, and verifying one on the return page). Relaxed to a
 * no-op under Jest, like every other per-route throttle (see `app.module.ts`).
 */
export const BILLING_CHECKOUT_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : 20,
    ttl: 60_000,
  },
};
