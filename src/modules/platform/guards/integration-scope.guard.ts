import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppError, ErrorCode } from '../../../common/errors';
import { REQUIRE_ANY_SCOPE_KEY, REQUIRE_SCOPES_KEY } from '../decorators/require-scopes.decorator';
import type { IntegrationScope } from '../integration-scopes.constants';

/**
 * Grants access only when the API-key principal's granted scopes
 * (`user.permissions` — populated by ApiKeyAuthGuard from `ApiKey.permissions`)
 * include EVERY scope required by `@RequireScopes(...)` on the route.
 *
 * Runs on external-integration routes only, after ApiKeyAuthGuard has already
 * populated `request.user` (via JwtAuthGuard's API-key delegation — see
 * jwt-auth.guard.ts) and ActiveTenantGuard has confirmed the tenant is usable.
 * There is no super-admin bypass here: a key is only ever as powerful as the
 * scopes explicitly granted to it, regardless of who issued it.
 */
@Injectable()
export class IntegrationScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<IntegrationScope[]>(
      REQUIRE_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const anyOf = this.reflector.getAllAndOverride<IntegrationScope[]>(
      REQUIRE_ANY_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const noAll = !required || required.length === 0;
    const hasAny = !!anyOf && anyOf.length > 0;
    if (noAll && !hasAny) {
      return true;
    }

    const user: AuthenticatedUser | undefined = context
      .switchToHttp()
      .getRequest().user;
    if (!user) {
      throw new AppError(ErrorCode.UNAUTHORIZED);
    }

    const allOk = (required ?? []).every((scope) => user.permissions.includes(scope));
    const anyOk = !hasAny || (anyOf as IntegrationScope[]).some((scope) => user.permissions.includes(scope));
    if (!allOk || !anyOk) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'This API key is missing a required scope for this endpoint',
      });
    }
    return true;
  }
}
