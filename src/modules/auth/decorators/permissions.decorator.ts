import { SetMetadata } from '@nestjs/common';
import type { PermissionSlug } from '../../../rbac/rbac.constants';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Restricts a route to users who hold ALL of the given permission slugs.
 * Enforced by PermissionsGuard.
 *
 * Arguments are typed as PermissionSlug, so only slugs defined in the RBAC
 * contract compile — a typo or a stale colon-style slug is a build error.
 */
export const RequirePermissions = (...permissions: PermissionSlug[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
