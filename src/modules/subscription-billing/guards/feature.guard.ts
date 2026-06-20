import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { FeatureFlagService } from '../feature-flag.service';
import { BillingModeService } from '../billing-mode.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';

/**
 * Runtime feature gate. When a handler/controller is annotated with
 * `@RequireFeature(key)`, the caller's tenant must have that feature flag
 * enabled — otherwise FeatureFlagService.assertEnabled throws 403.
 *
 * Depends only on Reflector, FeatureFlagService and TenantContextService. To use
 * it in OTHER modules via @UseGuards, FeatureFlagService must be globally
 * available (export it / make the module global) — see the lesson from
 * ActiveTenantGuard: class-referenced guards re-instantiate per host module.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly features: FeatureFlagService,
    private readonly billingMode: BillingModeService,
    private readonly ctx: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const featureKey = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!featureKey) return true; // no gate on this route

    const tenantId = this.ctx.getTenantId();
    if (!tenantId) return true; // super-admin / no-tenant: nothing to gate here

    // Global FREE platform mode opens every module to everyone — feature flags
    // are only enforced while the platform is in PAID mode.
    if (!(await this.billingMode.isPaidMode())) return true;

    await this.features.assertEnabled(tenantId, featureKey);
    return true;
  }
}
