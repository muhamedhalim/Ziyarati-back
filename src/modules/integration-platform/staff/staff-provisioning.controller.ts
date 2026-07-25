import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../../core/tenant-context/active-tenant.guard';

import { IntegrationStaffProvisioningService } from './integration-staff-provisioning.service';
import {
  ApproveStaffProvisioningDto,
  LinkStaffProvisioningDto,
  QueryStaffProvisioningDto,
  RejectStaffProvisioningDto,
} from '../dto/staff-provisioning.dto';

/**
 * Staff provisioning review queue (Phase 4).
 *
 * An external system can only ever ENQUEUE a request here. Creating the account
 * — and choosing the role — requires `platform.integrations.manage` PLUS
 * `staff.manage`: provisioning a login identity is a staff-administration
 * action, so holding only the integrations permission is not enough to mint an
 * account. Approval runs the platform's existing provisioning + set-password
 * invitation flow; no temporary password is ever returned.
 */
@ApiTags('Integration Staff Provisioning')
@ApiBearerAuth('JWT-auth')
@Controller('platform/integrations/staff-provisioning')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationStaffProvisioningController {
  constructor(
    private readonly provisioning: IntegrationStaffProvisioningService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List staff provisioning requests',
    description:
      '**Protected — `platform.integrations.read`.** External staff with no platform account, awaiting review. Defaults to `open` (pending + ambiguous).',
  })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  list(@Query() query: QueryStaffProvisioningDto) {
    return this.provisioning.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Approve — provision the account and send a set-password invitation',
    description:
      '**Protected — `platform.integrations.manage` AND `staff.manage`.** Creates the user + staff profile through the verified domain flow with the role YOU select (validated against the assignable-role policy — owner/super-admin are refused), maps the external id, and sends the standard single-use set-password invitation. No temporary password is ever exposed.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE, PERMISSION.STAFF_MANAGE)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveStaffProvisioningDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.provisioning.approve(this.ctx.requireTenantId(), id, dto, { userId, ip });
  }

  @ApiOperation({
    summary: 'Link to an existing staff member instead of creating an account',
    description:
      '**Protected — `platform.integrations.manage`.** The safe resolution for an ambiguous match. Creates only a mapping — the user account, its roles, its access state and all money/reputation fields are untouched.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkStaffProvisioningDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.provisioning.link(this.ctx.requireTenantId(), id, dto, { userId, ip });
  }

  @ApiOperation({
    summary: 'Reject a provisioning request',
    description: '**Protected — `platform.integrations.manage`.** No account is created and no mapping is made.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectStaffProvisioningDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.provisioning.reject(this.ctx.requireTenantId(), id, dto, { userId, ip });
  }

  @ApiOperation({
    summary: 'Re-send the set-password invitation',
    description:
      '**Protected — `platform.integrations.manage` AND `staff.manage`.** Delegates to the platform invitation flow, including its rule that someone who has already signed in must use "forgot password" instead.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/resend-invitation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE, PERMISSION.STAFF_MANAGE)
  resend(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string, @Ip() ip: string) {
    return this.provisioning.resendInvitation(this.ctx.requireTenantId(), id, { userId, ip });
  }
}
