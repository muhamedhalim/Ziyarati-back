import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ResourcePurchaseService } from './resource-purchase.service';
import { PreviewResourcePurchaseDto } from './dto/preview-resource-purchase.dto';
import { CreateResourcePurchaseDto } from './dto/create-resource-purchase.dto';
import { QueryResourcePurchasesDto } from './dto/query-resource-purchases.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { NoEntitlementRequired } from '../subscription-billing/decorators/no-entitlement-required.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

/**
 * Owner-facing resource-add-on purchases (Phase 2.2). Reuses
 * `billing_upgrade.read`/`billing_upgrade.manage` (plan §21 — no RBAC
 * migration); `billing_upgrade.manage` is already classified `'high'`
 * ("triggers a real charge"). Tenant is always
 * `TenantContextService.requireTenantId()`, never client-supplied.
 */
@ApiTags('Resource Purchases')
@ApiBearerAuth('JWT-auth')
@NoEntitlementRequired(FeatureKey.BILLING)
@Controller('resource-purchases')
@UseGuards(PermissionsGuard)
export class ResourcePurchaseController {
  constructor(
    private readonly purchases: ResourcePurchaseService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Preview a purchase — backend-authoritative price and resulting limit',
    description:
      '**Protected — `billing_upgrade.read`.** No side effects. The frontend never computes a price itself.',
  })
  @Post('preview')
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_READ)
  preview(@Body() dto: PreviewResourcePurchaseDto) {
    return this.purchases.preview(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Buy a resource add-on',
    description:
      '**Protected — `billing_upgrade.manage`.** Takes no price input. Returns a payment redirect URL; the entitlement is applied only after the payment is confirmed (webhook).',
  })
  @Post()
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_MANAGE)
  create(
    @Body() dto: CreateResourcePurchaseDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.purchases.create(this.ctx.requireTenantId(), dto, {
      id: user.id,
      email: user.email ?? undefined,
    });
  }

  @ApiOperation({
    summary: "List the tenant's purchase history",
    description: '**Protected — `billing_upgrade.read`.** Paginated, newest first.',
  })
  @Get()
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_READ)
  list(@Query() query: QueryResourcePurchasesDto) {
    return this.purchases.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Live usage count per purchasable CAPACITY item',
    description:
      "**Protected — `billing_upgrade.read`.** Not covered by `GET /usage/breakdown` (metered metrics only). Registered before ':id' so \"/usage\" is never parsed as a purchase id.",
  })
  @Get('usage')
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_READ)
  currentUsage() {
    return this.purchases.currentUsage(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Get one purchase',
    description: '**Protected — `billing_upgrade.read`.** 404 if it belongs to another tenant.',
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.get(this.ctx.requireTenantId(), id);
  }
}
