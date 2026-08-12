import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_ACTIVE_SUBSCRIPTION_KEY } from '../decorators/require-active-subscription.decorator';
import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { AccessControlService } from '../access-control.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppError, ErrorCode } from '../../../common/errors';

/**
 * DELETE is deliberately NOT gated by the grace-expired billable-action
 * refusal (FND-031/T082): removing something never increases usage or bills
 * the tenant, so blocking it during grace-expired would only make cleanup
 * harder for no protective purpose the finding asks for.
 */
const BILLABLE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Enforces platform access on routes annotated with `@RequireActiveSubscription()`.
 *
 * Delegates the decision to AccessControlService (global mode → free override →
 * paid subscription → feature override), so enforcement is centralized and
 * consistent everywhere. Reads the SAME route's `@RequireFeature()` key (when
 * present) and passes it through, so a tenant-specific feature-flag override
 * set via `/platform/feature-flags` can grant access to that route even with
 * no usable subscription — see `AccessControlService.resolveAccess`'s step 4.
 * A route without `@RequireFeature()` behaves exactly as before (no bypass).
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

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;
    // Unauthenticated is handled by JwtAuthGuard; super-admin/no-tenant bypasses.
    if (!user?.tenantId) return true;

    // Same route, same reflector call FeatureGuard makes — if this controller
    // also carries @RequireFeature(key), a tenant override for exactly that
    // key can substitute for a missing subscription (step 4 below).
    const featureKey = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    await this.access.assertUsable(user.tenantId, featureKey); // throws 403 when denied (broad gate — reads included)

    // FND-031/T082: narrower write-specific gate — read access (and DELETE,
    // which never increases usage) is preserved even once grace-expired;
    // only a genuinely billable/usage-increasing write is refused here.
    if (BILLABLE_METHODS.has(request.method.toUpperCase())) {
      const billable = await this.access.isBillableAllowed(user.tenantId);
      if (!billable) {
        throw new AppError(ErrorCode.SUBSCRIPTION_GRACE_EXPIRED);
      }
    }
    return true;
  }
}
