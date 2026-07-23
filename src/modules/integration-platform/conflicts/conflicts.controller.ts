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

import { IntegrationConflictService } from './integration-conflict.service';
import { IntegrationConflictResolutionService } from './integration-conflict-resolution.service';
import { QueryConflictsDto } from '../dto/query-conflicts.dto';
import { ResolveConflictDto } from '../dto/resolve-conflict.dto';

/**
 * Tenant-admin conflict queue (Phase 4). Lists persisted conflicts (safe
 * field-name + hash comparison only — never protected values) and resolves them
 * through the shared write pipeline. Guarded by PermissionsGuard +
 * ActiveTenantGuard.
 */
@ApiTags('Integration Conflicts')
@ApiBearerAuth('JWT-auth')
@Controller('platform/integrations/conflicts')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationConflictsController {
  constructor(
    private readonly conflicts: IntegrationConflictService,
    private readonly resolution: IntegrationConflictResolutionService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List conflicts',
    description: '**Protected — `platform.integrations.read`.** Field names + safe hash comparison only; never values.',
  })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  list(@Query() query: QueryConflictsDto) {
    return this.conflicts.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({ summary: 'Get a conflict', description: '**Protected — `platform.integrations.read`.**' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const c = await this.conflicts.getOrThrow(this.ctx.requireTenantId(), id);
    return {
      id: c.id,
      connectionId: c.connection?.id ?? null,
      resourceType: c.resource_type,
      externalId: c.external_id,
      internalResourceId: c.internal_resource_id ?? null,
      conflictingFields: c.conflicting_fields,
      stillDiffers: !!c.external_hash && !!c.platform_hash && c.external_hash !== c.platform_hash,
      policy: c.policy,
      status: c.status,
      resolution: c.resolution ?? null,
    };
  }

  @ApiOperation({
    summary: 'Resolve a conflict',
    description:
      '**Protected — `platform.integrations.manage`.** `external_wins` re-applies via the shared pipeline (requires `data`); `platform_wins`/`ignored` keep the platform record.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveConflictDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.resolution.resolve(this.ctx.requireTenantId(), id, dto, { userId, ip });
  }
}
