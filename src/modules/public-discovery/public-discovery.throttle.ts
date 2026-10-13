/**
 * Spec 014 (Clinic Platform Completion) — T069 (FR-P014). Per-IP throttle
 * ceilings for `PublicDiscoveryController`'s `@Public()` routes, following
 * `PUBLIC_AVAILABILITY_THROTTLE`'s and `public-booking.throttle.ts`'s shape. The
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

/** GET — the Marketplace's enriched clinic projection (contract C2b). Same
 *  ceiling as clinic detail; `MarketplaceThrottlerGuard` (contract C11)
 *  elevates it per-visitor when a valid platform key + visitor id are
 *  presented — this number is the fallback for every other caller. */
export const PUBLIC_DISCOVERY_MARKETPLACE_CLINIC_LIMIT = 30;

export const PUBLIC_DISCOVERY_MARKETPLACE_CLINIC_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_MARKETPLACE_CLINIC_LIMIT,
    ttl: 60_000,
  },
};

/** GET — the specialty index (C3). Small, cacheable, changes rarely. */
export const PUBLIC_DISCOVERY_SPECIALTIES_LIMIT = 60;

export const PUBLIC_DISCOVERY_SPECIALTIES_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_SPECIALTIES_LIMIT,
    ttl: 60_000,
  },
};

/** GET — the clinic-managed category index (C13). Two bounded queries over
 *  live service data, so it is held to the clinic-search ceiling rather than
 *  the specialty taxonomy's. */
export const PUBLIC_DISCOVERY_CATEGORIES_LIMIT = 30;

export const PUBLIC_DISCOVERY_CATEGORIES_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_CATEGORIES_LIMIT,
    ttl: 60_000,
  },
};

/** GET — a single specialty's paginated clinics/doctors (C4). */
export const PUBLIC_DISCOVERY_SPECIALTY_DETAIL_LIMIT = 30;

export const PUBLIC_DISCOVERY_SPECIALTY_DETAIL_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_SPECIALTY_DETAIL_LIMIT,
    ttl: 60_000,
  },
};

/** GET — doctor search (C5). Same enumeration-risk shape as clinic search. */
export const PUBLIC_DISCOVERY_DOCTORS_LIMIT = 30;

export const PUBLIC_DISCOVERY_DOCTORS_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_DOCTORS_LIMIT,
    ttl: 60_000,
  },
};

/** GET — single doctor detail by slug (C6). */
export const PUBLIC_DISCOVERY_DOCTOR_DETAIL_LIMIT = 30;

export const PUBLIC_DISCOVERY_DOCTOR_DETAIL_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_DOCTOR_DETAIL_LIMIT,
    ttl: 60_000,
  },
};

/** GET — cross-clinic service search (C7). Same enumeration-risk shape as
 *  doctor/clinic search. */
export const PUBLIC_DISCOVERY_SERVICES_LIMIT = 30;

export const PUBLIC_DISCOVERY_SERVICES_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_SERVICES_LIMIT,
    ttl: 60_000,
  },
};

/** GET — single service detail, clinic-scoped (C8). */
export const PUBLIC_DISCOVERY_SERVICE_DETAIL_LIMIT = 30;

export const PUBLIC_DISCOVERY_SERVICE_DETAIL_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_SERVICE_DETAIL_LIMIT,
    ttl: 60_000,
  },
};

/** GET — a doctor's avatar image (C12). Generous: a doctor listing/profile
 *  page can request several of these per view, and the response itself
 *  carries a 300s/3600s cache (`Cache-Control`), so real traffic mostly
 *  never reaches the origin at all. */
export const PUBLIC_DISCOVERY_DOCTOR_AVATAR_LIMIT = 120;

export const PUBLIC_DISCOVERY_DOCTOR_AVATAR_THROTTLE = {
  default: {
    limit:
      process.env.NODE_ENV === 'test'
        ? 1_000_000
        : PUBLIC_DISCOVERY_DOCTOR_AVATAR_LIMIT,
    ttl: 60_000,
  },
};
