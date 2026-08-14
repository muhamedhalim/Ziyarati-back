import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_ACTIVE_SUBSCRIPTION_KEY } from '../decorators/require-active-subscription.decorator';
import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { AccessControlService } from '../access-control.service';
import { FeatureKey } from '../feature-registry';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppError, ErrorCode } from '../../../common/errors';

import { resolveForRequest } from './request-access';

/**
 * DELETE is deliberately NOT gated by the grace-expired billable-action
 * refusal (FND-031/T082): removing something never increases usage or bills
 * the tenant, so blocking it during grace-expired would only make cleanup
 * harder for no protective purpose.
 */
const BILLABLE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Enforces platform access on routes annotated with `@RequireActiveSubscription()`.
 *
 * It makes NO access decision of its own — it asks `AccessControlService` and
 * enforces the answer. That separation is the fix for the original split: this
 * guard used to forward the route's `@RequireFeature()` key only when one
 * happened to be present, which made the super-admin feature-override path
 * reachable on 17 controllers and structurally unreachable on the other 37.
 * Those 37 returned NO_ACTIVE_SUBSCRIPTION to tenants the platform had
 * deliberately granted access to.
 *
 * Registered as a GLOBAL guard (APP_GUARD in AppModule, after JwtAuthGuard so
 * `request.user` is populated): it runs on every request but only acts where
 * the decorator is present, so adding `@RequireActiveSubscription()` to a
 * controller is the entire integration.
 *
 * IMPORTANT: the tenant id is read from `request.user` (set by JwtAuthGuard),
 * NOT from TenantContextService — the ALS principal is only populated by the
 * TenantContextInterceptor, which runs AFTER the guard phase, so a guard
 * reading the ALS context would always see null and silently bypass.
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

    // The same route's declared capability, when it has one. Passing it lets a
    // super-admin per-feature grant stand in for a missing subscription on
    // exactly this route — and only this route.
    const featureKey =
      this.reflector.getAllAndOverride<FeatureKey | undefined>(
        REQUIRE_FEATURE_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? null;

    const decision = await resolveForRequest(
      request,
      this.access,
      user.tenantId,
      featureKey,
    );
    if (
      !decision.allowed &&
      // Rollout switch (plan §18) — in shadow mode the denial is recorded and
      // the request proceeds. See `AccessPolicyModeService`.
      this.access.shouldBlock(decision, {
        surface: 'http',
        detail: `${request.method} ${request.route?.path ?? request.path}`,
      })
    ) {
      throw new AppError(ErrorCode.NO_ACTIVE_SUBSCRIPTION, {
        publicContext: { source: decision.source, featureKey },
        internalContext: { reason: decision.reason },
      });
    }

    // FND-031/T082: narrower write-specific gate — read access (and DELETE,
    // which never increases usage) is preserved even once grace-expired; only
    // a genuinely billable/usage-increasing write is refused here.
    if (BILLABLE_METHODS.has(request.method.toUpperCase())) {
      if (!(await this.access.isBillableAllowed(user.tenantId))) {
        throw new AppError(ErrorCode.SUBSCRIPTION_GRACE_EXPIRED);
      }
    }
    return true;
  }
}
