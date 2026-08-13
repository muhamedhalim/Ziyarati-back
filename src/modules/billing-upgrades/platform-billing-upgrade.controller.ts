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

import { BillingUpgradeAdminService } from './billing-upgrade-admin.service';
import { QueryPlatformBillingUpgradeRequestsDto } from './dto/query-billing-upgrade-requests.dto';
import { QuoteBillingUpgradeRequestDto } from './dto/quote-billing-upgrade-request.dto';
import { RejectBillingUpgradeRequestDto } from './dto/reject-billing-upgrade-request.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ROLE } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * PLATFORM-ONLY billing upgrade request review (super admin). Matches
 * PlatformBillingAdminController's convention exactly: RolesGuard +
 * @Roles(super_admin), no per-tenant scoping (cross-tenant by design).
 */
@ApiTags('Platform Billing Upgrade Requests (Super Admin)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/billing-upgrade-requests')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformBillingUpgradeController {
  constructor(private readonly service: BillingUpgradeAdminService) {}

  @ApiOperation({ summary: 'List billing upgrade requests across all tenants' })
  @Get()
  list(@Query() query: QueryPlatformBillingUpgradeRequestsDto) {
    return this.service.list(query);
  }

  @ApiOperation({
    summary: 'Get a request (full history, including internal notes)',
  })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @ApiOperation({
    summary: 'Generate or refresh the advisory AI cost estimate',
    description:
      'Advisory only — never determines the final price and never executes a charge. A provider failure never blocks manual pricing.',
  })
  @Post(':id/ai-estimate')
  @HttpCode(HttpStatus.OK)
  generateEstimate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.generateEstimate(id, {
      id: user.id,
      email: user.email ?? undefined,
    });
  }

  @ApiOperation({
    summary: 'Quote the request',
    description:
      'Sets approved quantity (usage_limit), final price, billing period, expiry, and notes. Moves the request to `awaiting_owner_approval`. Does NOT charge the tenant.',
  })
  @Post(':id/quote')
  @HttpCode(HttpStatus.OK)
  quote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QuoteBillingUpgradeRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.quote(
      id,
      { id: user.id, email: user.email ?? undefined },
      dto,
    );
  }

  @ApiOperation({ summary: 'Reject the request' })
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectBillingUpgradeRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.reject(
      id,
      { id: user.id, email: user.email ?? undefined },
      dto,
    );
  }
}
