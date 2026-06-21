import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { FeatureFlagService } from '../feature-flag.service';
import { BillingModeService } from '../billing-mode.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

/**
 * Runtime feature gate. When a handler/controller is annotated with
 * `@RequireFeature(key)`, the caller's tenant must have that feature flag
 * enabled — otherwise 403. Enforced only while the platform is in PAID mode
 * (global FREE mode opens every module to everyone).
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
    private readonly features: FeatureFlagService,
    private readonly billingMode: BillingModeService,
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

    await this.features.assertEnabled(user.tenantId, featureKey);
    return true;
  }
}
