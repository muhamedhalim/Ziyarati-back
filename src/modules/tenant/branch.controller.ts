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
  UseGuards,
} from '@nestjs/common';

import { BranchService } from './branch.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

/**
 * Branch management — a tenant BUSINESS resource.
 *
 *  - ActiveTenantGuard ensures the tenant is APPROVED + active (else 403).
 *  - The tenantId comes from TenantContextService (single source of truth);
 *    no `requireTenant(...)` duplication, no tenantId in the URL/body.
 */
@Controller('branches')
@UseGuards(RolesGuard, ActiveTenantGuard)
export class BranchController {
  constructor(
    private readonly branchService: BranchService,
    private readonly ctx: TenantContextService,
  ) {}

  @Post()
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  create(@Body() dto: CreateBranchDto) {
    return this.branchService.create(this.ctx.requireTenantId(), dto);
  }

  @Get()
  findAll() {
    return this.branchService.findAll(this.ctx.requireTenantId());
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.branchService.findOne(this.ctx.requireTenantId(), id);
  }

  @Patch(':id')
  @Roles(ROLE.OWNER, ROLE.MANAGER)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branchService.update(this.ctx.requireTenantId(), id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(ROLE.OWNER)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.branchService.remove(this.ctx.requireTenantId(), id);
  }
}
