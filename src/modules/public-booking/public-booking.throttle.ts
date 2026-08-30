/**
 * Spec 014 (Clinic Platform Completion) — T025 (FR-P014). Per-IP throttle
 * ceilings for the `@Public()` public booking routes, following
 * `GUEST_ATTACHMENT_THROTTLE`'s shape exactly. The platform-wide 300/min
 * default (`app.module.ts`) is explicitly insufficient here: an anonymous
 * visitor reaches these with no auth and no prior relationship to the
 * clinic at all.
 *
 * Refusals on these routes must be uniform and must never disclose whether
 * a clinic/branch/staff member existed (enforced by the controller, T067+)
 * — the throttle only bounds VOLUME; it says nothing about content.
 */

/** GET — reading free slots (the anonymous-safe projection, T018). A
 *  legitimate visitor may page across several days while choosing a time,
 *  so this is the most generous of the three — still far below the global
 *  default. */
export const PUBLIC_AVAILABILITY_LIMIT = 60;

/** POST — confirming a booking. A mutating, money/identity-adjacent
 *  request, so the tightest of the three. */
export const PUBLIC_BOOKING_CONFIRM_LIMIT = 10;

export const PUBLIC_AVAILABILITY_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : PUBLIC_AVAILABILITY_LIMIT,
    ttl: 60_000,
  },
};

export const PUBLIC_BOOKING_CONFIRM_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : PUBLIC_BOOKING_CONFIRM_LIMIT,
    ttl: 60_000,
  },
};
