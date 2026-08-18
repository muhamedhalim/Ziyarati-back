import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ResourceCatalogService } from './resource-catalog.service';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { NoEntitlementRequired } from '../subscription-billing/decorators/no-entitlement-required.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * Owner-facing pricing catalog — what a clinic may browse and buy
 * (Phase 2.1). Reuses `billing_upgrade.read` (plan §21 — no RBAC
 * migration); `@NoEntitlementRequired(FeatureKey.BILLING)` because billing
 * is `alwaysOn`, same as the legacy `BillingUpgradeController`. Read-only —
 * purchasing is Phase 2.2's `ResourcePurchaseController`.
 */
@ApiTags('Resource Pricing Catalog')
@ApiBearerAuth('JWT-auth')
@NoEntitlementRequired(FeatureKey.BILLING)
@Controller('resource-catalog')
@UseGuards(PermissionsGuard)
export class ResourcePricingController {
  constructor(private readonly catalog: ResourceCatalogService) {}

  @ApiOperation({
    summary: 'List active, priced resource add-ons available for purchase',
    description: '**Protected — `billing_upgrade.read`.**',
  })
  @Get()
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_READ)
  list() {
    return this.catalog.listActive();
  }

  @ApiOperation({
    summary: 'Get one active catalog item by key',
    description: '**Protected — `billing_upgrade.read`.** 404 if not sellable.',
  })
  @Get(':itemKey')
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_READ)
  get(@Param('itemKey') itemKey: string) {
    return this.catalog.getActiveByKey(itemKey);
  }
}
