import { ROLE, RoleSlug } from '../../rbac/rbac.constants';

/**
 * Roles Super Admin may assign to a PLATFORM user (tenantId = NULL) through
 * `/platform/staff`. A hardcoded allow-list, never a client-supplied role id
 * — `super_admin` is deliberately excluded (seeded only, never grantable
 * through any API) so this surface can never mint another Super Admin.
 */
export const PLATFORM_ASSIGNABLE_ROLE_SLUGS: readonly RoleSlug[] = [
  ROLE.PLATFORM_SUPPORT,
  ROLE.PLATFORM_SALES,
];

export function isPlatformAssignableRole(slug: string): slug is RoleSlug {
  return (PLATFORM_ASSIGNABLE_ROLE_SLUGS as readonly string[]).includes(slug);
}
