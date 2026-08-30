/**
 * Spec 014 (Clinic Platform Completion) — T069 (FR-P014). Per-IP throttle
 * ceilings for `PublicDiscoveryController`'s `@Public()` routes, following
 * `GUEST_ATTACHMENT_THROTTLE`'s and `public-booking.throttle.ts`'s shape. The
 * platform-wide 300/min default (`app.module.ts`) is explicitly insufficient
 * here: this is the enumeration surface for the entire public clinic
 * directory — a scraper needs no auth and no prior relationship to any
 * clinic to walk it.
 */

/** GET — cities with at least one bookable branch. Small, cacheable,
 *  changes rarely, so this is the most generous of the three. */
export const PUBLIC_DISCOVERY_CITIES_LIMIT = 60;

/** GET — free-text/city search. The highest enumeration risk of the three
 *  (arbitrary query strings), so it gets the tightest read limit. */
export const PUBLIC_DISCOVERY_CLINICS_LIMIT = 30;

/** GET — single clinic detail by id. Bounds brute-forcing clinic ids one at
 *  a time; a legitimate visitor only ever needs a handful per session. */
export const PUBLIC_DISCOVERY_CLINIC_DETAIL_LIMIT = 30;

export const PUBLIC_DISCOVERY_CITIES_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_CITIES_LIMIT,
    ttl: 60_000,
  },
};

export const PUBLIC_DISCOVERY_CLINICS_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_CLINICS_LIMIT,
    ttl: 60_000,
  },
};

export const PUBLIC_DISCOVERY_CLINIC_DETAIL_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_CLINIC_DETAIL_LIMIT,
    ttl: 60_000,
  },
};
