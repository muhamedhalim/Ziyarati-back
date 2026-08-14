import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { AccessControlService } from '../access-control.service';
import { FeatureKey } from '../feature-registry';
import { AccessSource } from '../tenant-access-decision';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppError, ErrorCode } from '../../../common/errors';

import { resolveForRequest } from './request-access';

/**
 * Runtime capability gate for `@RequireFeature(key)`.
 *
 * Delegates entirely to `AccessControlService` and reuses the decision
 * `SubscriptionAccessGuard` already resolved for this request. It previously
 * ran its own `FeatureResolverService.resolveTenant()` — 8 queries, a second
 * independent evaluation of the same question — which is how route gating and
 * the effective-feature view came to disagree, and why a capability whose key
 * had no `feature_definitions` row (`ai`) 403'd for every tenant regardless of
 * what they were paying for.
 *
 * Registered as a GLOBAL guard AFTER SubscriptionAccessGuard, so on a route
 * carrying both decorators the memo is already warm and this costs nothing.
 * On a route carrying only `@RequireFeature()`, this guard resolves it itself
 * — which is what lets a capability be gated without also demanding a
 * subscription.
 *
 * IMPORTANT: the tenant id comes from `request.user` (JwtAuthGuard), NOT from
 * TenantContextService — the ALS principal is populated by an interceptor that
 * runs after the guard phase, so an ALS read here would always be null and
 * would silently bypass the gate.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessControlService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const featureKey = this.reflector.getAllAndOverride<FeatureKey | undefined>(
      REQUIRE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!featureKey) return true; // no gate on this route

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user?.tenantId) return true; // super-admin / no-tenant: nothing to gate

    const decision = await resolveForRequest(
      request,
      this.access,
      user.tenantId,
      featureKey,
    );
    if (decision.allowed) return true;

    // Rollout switch (plan §18): in shadow mode the denial is recorded and the
    // request proceeds. Asked here rather than branched on locally so `shadow`
    // stays one switch in one place — see `AccessPolicyModeService`.
    if (
      !this.access.shouldBlock(decision, {
        surface: 'http',
        detail: `${request.method} ${request.route?.path ?? request.path}`,
      })
    ) {
      return true;
    }

    // A denial with no access path at all is a billing problem, and the tenant
    // needs the "choose a plan" copy. A denial while the tenant DOES hold
    // platform access is a capability problem — a different remedy, so it gets
    // a different error.
    if (decision.source === AccessSource.DENIED && !decision.grantedVia) {
      const base = await this.access.resolve(user.tenantId, null);
      if (!base.allowed) {
        throw new AppError(ErrorCode.NO_ACTIVE_SUBSCRIPTION, {
          publicContext: { source: base.source, featureKey },
          internalContext: { reason: decision.reason },
        });
      }
    }

    throw new AppError(ErrorCode.FORBIDDEN, {
      message: `The "${featureKey}" feature is not available for your subscription`,
      publicContext: { featureKey, source: decision.source },
      internalContext: { reason: decision.reason },
    });
  }
}
