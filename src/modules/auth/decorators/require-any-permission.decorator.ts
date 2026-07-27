import { SetMetadata } from '@nestjs/common';
import type { PermissionSlug } from '../../../rbac/rbac.constants';

export const ANY_PERMISSIONS_KEY = 'anyPermissions';

/**
 * Restricts a route to users who hold AT LEAST ONE of the given permission
 * slugs — the OR counterpart to `@RequirePermissions` (which requires ALL).
 * Enforced by the same `PermissionsGuard`.
 *
 * Use this where a route is shared between a full-access permission and its
 * ownership-scoped ("_own") counterpart, e.g.
 * `@RequireAnyPermission(PERMISSION.APPOINTMENTS_READ, PERMISSION.APPOINTMENTS_READ_OWN)`
 * — the guard only admits the request; the SERVICE layer still must apply
 * the ownership filter when only the "_own" permission is held (see
 * OWNERSHIP_SCOPED_PERMISSIONS in rbac.constants.ts).
 */
export const RequireAnyPermission = (...permissions: PermissionSlug[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);
