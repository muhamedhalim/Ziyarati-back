/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T134).
 *
 * Per-route throttle for `/public/unsubscribe/:token`, mirroring
 * `PATIENT_ACTION_LINK_*_THROTTLE`'s shape and rationale exactly: this route
 * is reachable by anyone with (or guessing at) a token, with no auth at all.
 */
export const UNSUBSCRIBE_RESOLVE_LIMIT = 20;
export const UNSUBSCRIBE_CONFIRM_LIMIT = 10;

export const UNSUBSCRIBE_RESOLVE_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test' ? 1_000_000 : UNSUBSCRIBE_RESOLVE_LIMIT,
    ttl: 60_000,
  },
};

export const UNSUBSCRIBE_CONFIRM_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test' ? 1_000_000 : UNSUBSCRIBE_CONFIRM_LIMIT,
    ttl: 60_000,
  },
};
