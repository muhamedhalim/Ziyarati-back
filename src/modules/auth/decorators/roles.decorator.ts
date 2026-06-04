import { SetMetadata } from '@nestjs/common';
import type { RoleSlug } from '../../../rbac/rbac.constants';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to users who hold at least one of the given role slugs.
 * Enforced by RolesGuard.
 *
 * Arguments are typed as RoleSlug, so only slugs defined in the RBAC contract
 * compile.
 */
export const Roles = (...roles: RoleSlug[]) => SetMetadata(ROLES_KEY, roles);
