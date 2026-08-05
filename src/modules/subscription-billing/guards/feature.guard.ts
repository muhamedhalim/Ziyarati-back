import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { BillingModeService } from '../billing-mode.service';
import { FeatureResolverService } from '../feature-resolver.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppError, ErrorCode } from '../../../common/errors';

/**
 * Runtime feature gate. When a handler/controller is annotated with
 * `@RequireFeature(key)`, the caller's tenant must have that feature
 * AVAILABLE — otherwise 403. Enforced only while the platform is in PAID mode
 * (global FREE mode opens every module to everyone).
 *
 * FND-033/FR-B009: resolves through `FeatureResolverService.resolveTenant` —
 * the EXACT SAME chain `GET /feature-flags/effective` uses (plan inclusion,
 * dependencies, usage quota, override) — NOT the raw per-tenant
 * `feature_flags` row alone. That raw row is caller-writable by anyone
 * holding `featureflag.manage` (`PUT /feature-flags`, tenant-scoped, no plan
 * check at write time), so checking only the flag let a tenant on a plan
 * that does NOT include a feature self-enable it at the route level — route
 * gating and the effective-feature view MUST agree by construction, which
 * routing both through the same resolver guarantees rather than merely
 * hoping two independent checks stay in sync.
 *
 * Registered as a GLOBAL guard (APP_GUARD in AppModule, after JwtAuthGuard) so
 * one `@RequireFeature(...)` annotation is the entire integration.
 *
 * IMPORTANT: the tenant id is read from `request.user` (set by JwtAuthGuard),
 * NOT from TenantContextService — the ALS principal is populated by the
 * TenantContextInterceptor, which runs AFTER the guard phase, so a guard reading
 * the ALS context would always see null and silently bypass.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billingMode: BillingModeService,
    private readonly resolver: FeatureResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const featureKey = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!featureKey) return true; // no gate on this route

    const user = context.switchToHttp().getRequest<Request>().user as
      | AuthenticatedUser
      | undefined;
    if (!user?.tenantId) return true; // super-admin / no-tenant: nothing to gate

    // Global FREE platform mode opens every module to everyone — feature flags
    // are only enforced while the platform is in PAID mode.
    if (!(await this.billingMode.isPaidMode())) return true;

    const { features } = await this.resolver.resolveTenant(user.tenantId);
    const resolved = features.find((f) => f.featureKey === featureKey);
    if (!resolved?.available) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `The "${featureKey}" feature is not available for your subscription`,
        publicContext: { featureKey, blockedReason: resolved?.blockedReason ?? 'disabled' },
      });
    }
    return true;
  }
}
