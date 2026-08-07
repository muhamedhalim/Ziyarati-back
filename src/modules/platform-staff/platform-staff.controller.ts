import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PlatformStaffService } from './platform-staff.service';
import { CreatePlatformStaffDto } from './dto/create-platform-staff.dto';
import { UpdatePlatformStaffDto } from './dto/update-platform-staff.dto';
import { SetPlatformStaffStatusDto } from './dto/set-platform-staff-status.dto';
import { SetPlatformStaffRolesDto } from './dto/set-platform-staff-roles.dto';
import { QueryPlatformStaffDto } from './dto/query-platform-staff.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Super Admin management of Platform Customer Service staff. SUPER ADMIN
 * ONLY (RolesGuard) — this surface itself creates/manages the platform
 * principals that hold restricted permissions elsewhere, so it is
 * role-gated, never permission-gated (mirrors PlatformSupportTicketController
 * and every other `@Roles(ROLE.SUPER_ADMIN)` platform controller). A clinic
 * Owner holding `users.manage`/`roles.manage` has no access here at all.
 */
@ApiTags('Platform Staff')
@ApiBearerAuth('JWT-auth')
@Controller('platform/staff')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformStaffController {
  constructor(private readonly staff: PlatformStaffService) {}

  @ApiOperation({ summary: 'List platform staff (super admin)' })
  @Get()
  list(@Query() query: QueryPlatformStaffDto) {
    return this.staff.list(query);
  }

  @ApiOperation({
    summary:
      'List assignable platform roles + their permission preview (super admin)',
  })
  @Get('roles')
  listAssignableRoles() {
    return this.staff.listAssignableRoles();
  }

  @ApiOperation({
    summary: 'Invite a new platform staff member (super admin)',
    description:
      'Provisions a tenantId=NULL user with the given platform role and emails a single-use ' +
      'set-password invitation. No password is ever returned in the response.',
  })
  @Post()
  create(
    @Body() dto: CreatePlatformStaffDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.staff.create(dto, actorUserId);
  }

  @ApiOperation({
    summary: 'Re-issue the set-password invitation (super admin)',
  })
  @Post(':id/resend-invitation')
  resendInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.staff.resendInvitation(id, actorUserId);
  }

  @ApiOperation({ summary: 'Update allowed profile fields (super admin)' })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformStaffDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.staff.update(id, dto, actorUserId);
  }

  @ApiOperation({
    summary: 'Activate or deactivate a platform staff account (super admin)',
    description:
      'Deactivation also revokes every refresh token so a live session dies on its next request.',
  })
  @Patch(':id/status')
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPlatformStaffStatusDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.staff.setStatus(id, dto, actorUserId);
  }

  @ApiOperation({
    summary: "Replace a platform staff member's role set (super admin)",
    description:
      'Roles are resolved by slug against a hardcoded platform allow-list — a client-supplied role id ' +
      'is never trusted, and `super_admin` can never be assigned through this endpoint.',
  })
  @Put(':id/roles')
  setRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPlatformStaffRolesDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.staff.setRoles(id, dto, actorUserId);
  }
}
