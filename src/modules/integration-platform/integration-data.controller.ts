import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { AppError, ErrorCode } from '../../common/errors';

import { IntegrationIdMapService } from './integration-id-map.service';
import { IntegrationImportService } from './integration-import.service';
import { QueryMappingsDto } from './dto/query-mappings.dto';
import { BatchImportDto } from './dto/batch-import.dto';
import { INTEGRATION_RESOURCE, isIntegrationResource } from './integration-platform.constants';

/**
 * Tenant-admin mapping viewer + synchronous batch import (Phase 3). Import
 * reuses the shared write pipeline; the resource is a path param validated
 * against the fixed allowlist. Import only supports resources whose write path
 * exists (customers, services) this phase.
 */
@ApiTags('Integration Data')
@ApiBearerAuth('JWT-auth')
@Controller('platform/integrations')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationDataController {
  constructor(
    private readonly idMap: IntegrationIdMapService,
    private readonly imports: IntegrationImportService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'List external-id mappings', description: '**Protected — `platform.integrations.read`.** Ids only; never record content.' })
  @Get('mappings')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  listMappings(@Query() query: QueryMappingsDto) {
    return this.idMap.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Batch import a resource',
    description:
      '**Protected — `platform.integrations.manage`.** Bounded synchronous import (customers|services). Supports `dryRun`. Returns per-record counts + safe errors.',
  })
  @ApiParam({ name: 'resource', enum: [INTEGRATION_RESOURCE.CUSTOMER, INTEGRATION_RESOURCE.SERVICE] })
  @Post('imports/:resource')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  import(
    @Param('resource') resource: string,
    @Body() dto: BatchImportDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    if (!isIntegrationResource(resource)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Unknown resource type' });
    }
    return this.imports.import(this.ctx.requireTenantId(), resource, dto, { userId, ip });
  }
}
