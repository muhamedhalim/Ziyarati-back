import {
  Body,
  Controller,
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

import { TenantService } from './tenant.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ListTenantsQueryDto } from './dto/list-tenants.query.dto';
import { TenantApprovalActionDto } from './dto/tenant-approval-action.dto';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

/**
 * Two audiences, one resource:
 *  - PLATFORM admin (super_admin): list / create / inspect / approve / reject /
 *    suspend ANY tenant (the `/:id` routes).
 *  - TENANT self-service (owner/manager within their own tenant): the `/me`
 *    routes, always scoped to the principal's own tenantId.
 *
 * `/me*` routes are declared before `/:id` so they are matched literally.
 */
@Controller('tenants')
@UseGuards(RolesGuard)
export class TenantController {
  constructor(
    private readonly tenantService: TenantService,
    private readonly ctx: TenantContextService,
  ) {}

  // ----------------------------- platform admin ------------------------- //

  @Post()
  @Roles(ROLE.SUPER_ADMIN)
  create(
    @Body() dto: CreateTenantDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.tenantService.create(dto, actorId);
  }

  @Get()
  @Roles(ROLE.SUPER_ADMIN)
  findAll(@Query() query: ListTenantsQueryDto) {
    return this.tenantService.findAll(query);
  }

  // ------------------------------ self-service --------------------------- //

  @Get('me')
  myTenant() {
    return this.tenantService.findById(this.ctx.requireTenantId());
  }

  @Patch('me')
  @Roles(ROLE.OWNER)
  updateMyTenant(@Body() dto: UpdateTenantDto) {
    return this.tenantService.updateProfile(this.ctx.requireTenantId(), dto);
  }

  @Get('me/settings')
  mySettings() {
    return this.tenantService.getSettings(this.ctx.requireTenantId());
  }

  @Patch('me/settings')
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  updateMySettings(@Body() dto: UpdateTenantSettingsDto) {
    return this.tenantService.updateSettings(this.ctx.requireTenantId(), dto);
  }

  // --------------------------- platform admin (by id) ------------------- //

  @Get(':id')
  @Roles(ROLE.SUPER_ADMIN)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantService.findById(id);
  }

  @Patch(':id')
  @Roles(ROLE.SUPER_ADMIN)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenantService.updateProfile(id, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(ROLE.SUPER_ADMIN)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantApprovalActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.tenantService.approve(id, actorId, dto.reason);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(ROLE.SUPER_ADMIN)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantApprovalActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.tenantService.reject(id, actorId, dto.reason);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @Roles(ROLE.SUPER_ADMIN)
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TenantApprovalActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.tenantService.suspend(id, actorId, dto.reason);
  }

  @Get(':id/approval-events')
  @Roles(ROLE.SUPER_ADMIN)
  approvalEvents(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantService.getApprovalEvents(id);
  }
}
