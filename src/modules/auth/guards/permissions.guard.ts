import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { PermissionSlug, ROLE } from '../../../rbac/rbac.constants';

/**
 * Grants access only when the user holds EVERY required permission slug.
 * Runs after JwtAuthGuard, so `request.user` is already populated.
 *
 * Comparison uses the dot-notation slugs from the RBAC contract — the exact
 * same strings the seeder writes to the database and the strategy loads onto
 * the principal.
 *
 * super_admin short-circuits every permission check, so "super admin has all
 * permissions" holds dynamically without depending on the seeded grant set.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionSlug[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }

    const user: AuthenticatedUser | undefined = context
      .switchToHttp()
      .getRequest().user;
    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // Platform super-admin bypasses permission checks.
    if (user.roles.includes(ROLE.SUPER_ADMIN)) {
      return true;
    }

    const hasAll = required.every((perm) => user.permissions.includes(perm));
    if (!hasAll) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
