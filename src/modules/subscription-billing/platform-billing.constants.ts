import { ConfigService } from '@nestjs/config';

/**
 * Platform-level billing constants.
 *
 * These govern the GLOBAL access-control behaviour of the SaaS, all controlled by
 * the super admin:
 *  - the global billing mode (free vs paid platform), stored in `system_settings`
 *  - the free-access-override ledger (`free_access_overrides`)
 *
 * The access-resolution priority is fixed and documented here so every consumer
 * agrees on it:  GLOBAL MODE  →  FREE OVERRIDE  →  PAID SUBSCRIPTION  →
 * FEATURE OVERRIDE (scoped to the one route/feature a super-admin explicitly
 * enabled via `/platform/feature-flags`; see AccessSource.FEATURE_OVERRIDE
 * and AccessControlService.resolveAccess).
 */

/** Global platform billing mode. Stored as `system_settings.value` under MODE_KEY. */
export enum BillingMode {
  /** Mode A — everyone has access, no subscription required, enforcement OFF. */
  FREE = 'free',
  /** Mode B — subscription/entitlements enforced; access requires a usable plan. */
  PAID = 'paid',
}

/**
 * Default mode when unset. FREE is the safe rollout default: turning enforcement
 * on is an explicit super-admin action, so introducing this system can never
 * retroactively lock out existing tenants ("must not break existing user states").
 */
export const DEFAULT_BILLING_MODE = BillingMode.FREE;

/** `system_settings.key` under which the global billing mode is persisted. */
export const BILLING_MODE_SETTING_KEY = 'billing.mode';

/** Free-access-override lifecycle. */
export enum OverrideStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

/**
 * Bounds on a TIME-BOXED free-access grant, in days.
 *
 * The API is the authority on these, never the console: the slider on
 * `/platform/feature-flags` merely mirrors them, and a caller that bypasses
 * the UI is refused by `GrantOverrideDto`/`ExtendOverrideDto` and again by
 * `FreeAccessOverrideService` — which seeds and other in-process callers reach
 * without passing through a DTO at all.
 *
 * MIN is 1: a zero-day grant is indistinguishable from not granting, and a
 * negative one back-dates `ends_at` into the past — a grant already expired
 * the instant it is written. MAX is 365: a comp longer than a year is a
 * commercial decision that should be re-made deliberately rather than reached
 * by dragging a slider. Omitting `durationDays` remains the explicit,
 * unbounded UNLIMITED grant; that is a separate and visible choice, and these
 * bounds deliberately do not constrain it.
 */
export const FREE_ACCESS_MIN_DURATION_DAYS = 1;
export const FREE_ACCESS_MAX_DURATION_DAYS = 365;

/**
 * The `/platform/billing/overview` "expiring" filter bucket boundary — an
 * ADMIN-VISIBILITY grouping only ("show me clinics losing free access soon"),
 * independent of the 48h server-side expiry-warning notice window
 * (`FreeAccessNoticeService`'s sweep). An ACTIVE, time-boxed override with
 * `daysRemaining <= this` is "expiring"; otherwise "active".
 */
export const FREE_ACCESS_OVERVIEW_EXPIRING_SOON_DAYS = 7;

/**
 * Rollout kill switch for the free-access notice pipeline (start notice +
 * 48h expiry warning). Checked by BOTH `FreeAccessOverrideService.grant`
 * (whether to write the start-notice outbox row at all) and
 * `FreeAccessNoticeService.sweepExpiring` (whether to claim anything) — one
 * function so the two can never read the flag differently. Defaults ON;
 * flip to 'false' only for the brief window between deploying the schema/API
 * and deploying the worker that knows the job name (see the plan's
 * Deployment Plan §19).
 */
export function freeAccessNoticesEnabled(config: ConfigService): boolean {
  return config.get<string>('FREE_ACCESS_NOTICES_ENABLED', 'true') !== 'false';
}

/**
 * `AccessSource` now lives with the rest of the decision shape in
 * `tenant-access-decision.ts` — re-exported here so the many existing
 * `from './platform-billing.constants'` imports keep working. The string
 * values are unchanged; only the member names were clarified.
 */
export { AccessSource } from './tenant-access-decision';
