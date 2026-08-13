import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { BillingUpgradeService } from './billing-upgrade.service';
import { CreateBillingUpgradeRequestDto } from './dto/create-billing-upgrade-request.dto';
import { QueryBillingUpgradeRequestsDto } from './dto/query-billing-upgrade-requests.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { NoEntitlementRequired } from '../subscription-billing/decorators/no-entitlement-required.decorator';

/**
 * Owner-facing billing upgrade requests. Tenant is always
 * `TenantContextService.requireTenantId()` — never a client-supplied id.
 */
@ApiTags('Billing Upgrade Requests')
@ApiBearerAuth('JWT-auth')
@NoEntitlementRequired()
@Controller('billing-upgrade-requests')
@UseGuards(PermissionsGuard)
export class BillingUpgradeController {
  constructor(
    private readonly service: BillingUpgradeService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Request a plan-excluded feature or a usage-limit increase',
    description:
      '**Protected — `billing_upgrade.manage`.** Starts at `pending_review`. 409 if an active request already exists for the same feature/metric.',
  })
  @Post()
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_MANAGE)
  create(
    @Body() dto: CreateBillingUpgradeRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(
      this.ctx.requireTenantId(),
      { id: user.id, email: user.email ?? undefined },
      dto,
    );
  }

  @ApiOperation({
    summary: "List the tenant's billing upgrade requests",
    description:
      '**Protected — `billing_upgrade.read`.** Paginated, newest first.',
  })
  @Get()
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_READ)
  list(@Query() query: QueryBillingUpgradeRequestsDto) {
    return this.service.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get a billing upgrade request (with owner-visible history)',
    description:
      '**Protected — `billing_upgrade.read`.** 404 if it belongs to another tenant.',
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Cancel a request',
    description:
      '**Protected — `billing_upgrade.manage`.** Only from `pending_review`, `awaiting_owner_approval`, or `payment_failed`.',
  })
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_MANAGE)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.cancel(this.ctx.requireTenantId(), id, {
      id: user.id,
      email: user.email ?? undefined,
    });
  }

  @ApiOperation({
    summary: 'Accept the quote and start payment',
    description:
      '**Protected — `billing_upgrade.manage`.** Takes NO financial input — the final price is always read from the server-set quote. Returns a payment redirect URL; the entitlement is applied only after the payment is confirmed (webhook).',
  })
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.BILLING_UPGRADE_MANAGE)
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.accept(this.ctx.requireTenantId(), id, {
      id: user.id,
      email: user.email ?? undefined,
    });
  }
}
