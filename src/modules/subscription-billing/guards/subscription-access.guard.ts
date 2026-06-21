import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_ACTIVE_SUBSCRIPTION_KEY } from '../decorators/require-active-subscription.decorator';
import { AccessControlService } from '../access-control.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

/**
 * Enforces platform access on routes annotated with `@RequireActiveSubscription()`.
 *
 * Delegates the decision to AccessControlService (global mode → free override →
 * paid subscription), so enforcement is centralized and consistent everywhere.
 *
 * Registered as a GLOBAL guard (APP_GUARD in AppModule, after JwtAuthGuard so
 * `request.user` is populated): it runs on every request but only acts where the
 * decorator is present, so adding `@RequireActiveSubscription()` to a controller
 * is the entire integration — no per-module guard wiring.
 *
 * IMPORTANT: the tenant id is read from `request.user` (set by JwtAuthGuard),
 * NOT from TenantContextService — the ALS principal is only populated by the
 * TenantContextInterceptor, which runs AFTER the guard phase.
 *
 * No tenant on the principal (super-admin / platform call) is not gated —
 * platform operators are never blocked by tenant billing state.
 */
@Injectable()
export class SubscriptionAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessControlService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRE_ACTIVE_SUBSCRIPTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // route not gated

    const user = context.switchToHttp().getRequest<Request>().user as
      | AuthenticatedUser
      | undefined;
    // Unauthenticated is handled by JwtAuthGuard; super-admin/no-tenant bypasses.
    if (!user?.tenantId) return true;

    await this.access.assertUsable(user.tenantId); // throws 403 when denied
    return true;
  }
}
