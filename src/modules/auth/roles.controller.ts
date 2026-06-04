import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';

import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { SetRolePermissionsDto } from './dto/set-role-permissions.dto';

import { CurrentUser } from './decorators/current-user.decorator';
import { RequirePermissions } from './decorators/permissions.decorator';
import { PermissionsGuard } from './guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';

/**
 * Role administration. Everything is scoped to the caller's tenant; the tenant
 * id is taken from the authenticated principal, never from the request body,
 * to keep tenants isolated.
 */
@Controller('roles')
@UseGuards(PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  create(
    @Body() dto: CreateRoleDto,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.create(dto, tenantId);
  }

  @Get()
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  findAll(@CurrentUser('tenantId') tenantId: string | null) {
    return this.rolesService.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.findOne(id, tenantId);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.update(id, dto, tenantId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.remove(id, tenantId);
  }

  @Put(':id/permissions')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  setPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolePermissionsDto,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.setPermissions(id, dto.permissionIds, tenantId);
  }

  // --------------------------- user assignment --------------------------- //

  @Post(':id/users/:userId')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  assign(
    @Param('id', ParseUUIDPipe) roleId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.assignRoleToUser(userId, roleId, tenantId);
  }

  @Delete(':id/users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  unassign(
    @Param('id', ParseUUIDPipe) roleId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.removeRoleFromUser(userId, roleId, tenantId);
  }

  @Get('users/:userId')
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  userRoles(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    return this.rolesService.listUserRoles(userId, tenantId);
  }
}
