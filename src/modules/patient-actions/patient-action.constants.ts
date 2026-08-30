/**
 * Spec 014 (Clinic Platform Completion) — T025 (FR-C016). Per-IP throttle
 * ceilings for the `@Public()` patient action-link routes, following
 * `GUEST_ATTACHMENT_THROTTLE`'s shape exactly. The platform-wide 300/min
 * default (`app.module.ts`) is explicitly insufficient here: these routes
 * are reachable by anyone with (or guessing at) a link, with no auth at all,
 * so each gets its own, much tighter ceiling.
 *
 * Refusals on these routes must be uniform and must never disclose whether
 * a token or clinic existed (enforced by the controller, T059+) — the
 * throttle only bounds VOLUME; it says nothing about content.
 */

/** GET — resolving a token to learn what it authorises. A brute-force
 *  guessing surface, so the tightest of the three. */
export const PATIENT_ACTION_LINK_RESOLVE_LIMIT = 20;

/** POST — confirming a cancellation/reschedule/waitlist-offer action. A
 *  mutating request, so stricter than a mere resolve. */
export const PATIENT_ACTION_LINK_CONFIRM_LIMIT = 10;

export const PATIENT_ACTION_LINK_RESOLVE_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : PATIENT_ACTION_LINK_RESOLVE_LIMIT,
    ttl: 60_000,
  },
};

export const PATIENT_ACTION_LINK_CONFIRM_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : PATIENT_ACTION_LINK_CONFIRM_LIMIT,
    ttl: 60_000,
  },
};
