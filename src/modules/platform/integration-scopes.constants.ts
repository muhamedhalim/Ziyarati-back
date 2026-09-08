import { PERMISSION, PermissionSlug } from '../../rbac/rbac.constants';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * External integration API scopes — a DELIBERATELY SEPARATE namespace from
 * the internal RBAC permission contract (`rbac.constants.ts`). An API key is a
 * long-lived, exportable credential handed to a third-party system, so it must
 * never carry a raw internal permission slug (`services.read`, `staff.read`,
 * ...): those slugs also unlock internal dashboard/admin behaviour and their
 * meaning can change independently of what a clinic integration should see.
 *
 * Each scope below maps to the ONE internal permission a caller must already
 * hold to grant it — enforced by `assertScopesGrantable` at key create/rotate
 * time, so a key can never carry more access than its issuer has.
 */
export const INTEGRATION_SCOPE = {
  SERVICES_READ: 'integration.services.read',
  STAFF_READ: 'integration.staff.read',
  AVAILABILITY_READ: 'integration.availability.read',
  CUSTOMERS_READ: 'integration.customers.read',
  APPOINTMENTS_READ: 'integration.appointments.read',

  // Write scopes (Phase 3 — two-way integrations). A separate, strictly
  // higher-privilege set from the read scopes above: a key must hold the write
  // scope AND its issuer must hold the underlying internal write permission.
  CUSTOMERS_WRITE: 'integration.customers.write',
  SERVICES_WRITE: 'integration.services.write',
  STAFF_WRITE: 'integration.staff.write',
  APPOINTMENTS_WRITE: 'integration.appointments.write',

  // Marketplace contract C11 — deliberately NOT tenant-scoped: this key
  // authenticates the book.ziyaratech.com frontend's server-rendered discovery
  // reads for elevated, per-visitor throttling (MarketplaceThrottlerGuard). It
  // grants no tenant data access at all — see INTEGRATION_SCOPE_REQUIRES below,
  // where it is deliberately absent from the map and only issuable via
  // `ApiKeyService.createPlatformKey()` (super-admin only, no tenant).
  MARKETPLACE_DISCOVERY: 'marketplace:discovery',
} as const;

export type IntegrationScope =
  (typeof INTEGRATION_SCOPE)[keyof typeof INTEGRATION_SCOPE];

/** Every valid scope string — used by the DTO allowlist validator. */
export const INTEGRATION_SCOPES: IntegrationScope[] =
  Object.values(INTEGRATION_SCOPE);

/**
 * The internal permission a caller must hold to grant each scope to a key, so a
 * key can never carry more access than its issuer. Read scopes (Phase 1) map to
 * the matching read permission; write scopes (Phase 3) map to the write/create
 * permission.
 *
 * `MARKETPLACE_DISCOVERY` has NO entry here, deliberately: it maps to no
 * tenant-held permission at all, so `assertScopesGrantable` always treats it as
 * ungrantable for a non-super-admin caller (the `missing` check below), and it
 * is only ever issued via the super-admin-only `createPlatformKey` bypass.
 */
export const INTEGRATION_SCOPE_REQUIRES: Partial<Record<IntegrationScope, PermissionSlug>> = {
  [INTEGRATION_SCOPE.SERVICES_READ]: PERMISSION.SERVICES_READ,
  [INTEGRATION_SCOPE.STAFF_READ]: PERMISSION.STAFF_READ,
  [INTEGRATION_SCOPE.AVAILABILITY_READ]: PERMISSION.SCHEDULING_AVAILABILITY_READ,
  [INTEGRATION_SCOPE.CUSTOMERS_READ]: PERMISSION.CRM_CUSTOMERS_READ,
  [INTEGRATION_SCOPE.APPOINTMENTS_READ]: PERMISSION.APPOINTMENTS_READ,

  // Write scopes require the underlying internal WRITE/CREATE permission.
  [INTEGRATION_SCOPE.CUSTOMERS_WRITE]: PERMISSION.CUSTOMERS_MANAGE,
  [INTEGRATION_SCOPE.SERVICES_WRITE]: PERMISSION.SERVICES_CREATE,
  [INTEGRATION_SCOPE.STAFF_WRITE]: PERMISSION.STAFF_MANAGE,
  [INTEGRATION_SCOPE.APPOINTMENTS_WRITE]: PERMISSION.APPOINTMENTS_CREATE,
};

/** Narrows an arbitrary string array to the ones that are valid scopes (legacy/junk-safe). */
export function normalizeScopes(raw: unknown): IntegrationScope[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(INTEGRATION_SCOPES);
  return raw.filter((s): s is IntegrationScope => typeof s === 'string' && valid.has(s));
}

/**
 * Throws FORBIDDEN if any requested scope's required internal permission is
 * not held by the caller. `super_admin` (no seeded permission rows) is exempt,
 * mirroring PermissionsGuard's bypass.
 */
export function assertScopesGrantable(
  requested: string[] | undefined,
  callerPermissions: string[],
  isSuperAdmin: boolean,
): void {
  if (isSuperAdmin || !requested?.length) return;
  const heldSet = new Set(callerPermissions);
  const missing = requested.filter((scope) => {
    const required = INTEGRATION_SCOPE_REQUIRES[scope as IntegrationScope];
    return !required || !heldSet.has(required);
  });
  if (missing.length > 0) {
    throw new AppError(ErrorCode.FORBIDDEN, {
      message: `Cannot grant scope(s) you do not hold the underlying permission for: ${missing.join(', ')}`,
    });
  }
}
