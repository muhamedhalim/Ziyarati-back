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
 * `AccessSource` now lives with the rest of the decision shape in
 * `tenant-access-decision.ts` — re-exported here so the many existing
 * `from './platform-billing.constants'` imports keep working. The string
 * values are unchanged; only the member names were clarified.
 */
export { AccessSource } from './tenant-access-decision';
