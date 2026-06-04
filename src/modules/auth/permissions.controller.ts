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
  Query,
  UseGuards,
} from '@nestjs/common';

import { PermissionsService } from './permissions.service';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

import { Roles } from './decorators/roles.decorator';
import { RequirePermissions } from './decorators/permissions.decorator';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';

/**
 * The permission catalogue is global. Reading it is available to anyone allowed
 * to manage roles (so they can attach permissions); mutating it is restricted
 * to platform super-admins via the `super_admin` system role.
 */
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(ROLE.SUPER_ADMIN)
  create(@Body() dto: CreatePermissionDto) {
    return this.permissionsService.create(dto);
  }

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  findAll(@Query('module') module?: string) {
    return this.permissionsService.findAll(module);
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(PERMISSION.ROLES_MANAGE)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.permissionsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(ROLE.SUPER_ADMIN)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePermissionDto,
  ) {
    return this.permissionsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @Roles(ROLE.SUPER_ADMIN)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.permissionsService.remove(id);
  }
}
