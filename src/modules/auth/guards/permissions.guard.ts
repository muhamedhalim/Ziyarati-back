import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { ANY_PERMISSIONS_KEY } from '../decorators/require-any-permission.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { PermissionSlug, ROLE } from '../../../rbac/rbac.constants';
import { AppError, ErrorCode } from '../../../common/errors';

/**
 * Grants access only when the user holds EVERY permission slug required by
 * `@RequirePermissions` (if present) AND AT LEAST ONE slug required by
 * `@RequireAnyPermission` (if present) — both may be declared on the same
 * route and are combined with AND. Runs after JwtAuthGuard, so `request.user`
 * is already populated.
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
    const requiredAny = this.reflector.getAllAndOverride<PermissionSlug[]>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const hasRequired = required && required.length > 0;
    const hasRequiredAny = requiredAny && requiredAny.length > 0;
    if (!hasRequired && !hasRequiredAny) {
      return true;
    }

    const user: AuthenticatedUser | undefined = context
      .switchToHttp()
      .getRequest().user;
    if (!user) {
      throw new AppError(ErrorCode.PERMISSION_DENIED);
    }

    // Platform super-admin bypasses permission checks.
    if (user.roles.includes(ROLE.SUPER_ADMIN)) {
      return true;
    }

    if (hasRequired && !required.every((perm) => user.permissions.includes(perm))) {
      throw new AppError(ErrorCode.PERMISSION_DENIED);
    }
    if (hasRequiredAny && !requiredAny.some((perm) => user.permissions.includes(perm))) {
      throw new AppError(ErrorCode.PERMISSION_DENIED);
    }
    return true;
  }
}
