import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../../core/tenant-context/active-tenant.guard';

import { IntegrationIdMapService } from './integration-id-map.service';
import { QueryMappingsDto } from '../dto/query-mappings.dto';

/**
 * Tenant-admin viewer for external-id ⇄ internal-id mappings (Phase 3). Ids only
 * — never record content. Guarded by PermissionsGuard + ActiveTenantGuard; the
 * tenant id comes from TenantContext.
 */
@ApiTags('Integration Mappings')
@ApiBearerAuth('JWT-auth')
@Controller('platform/integrations')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationMappingsController {
  constructor(
    private readonly idMap: IntegrationIdMapService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List external-id mappings',
    description: '**Protected — `platform.integrations.read`.** Ids only; never record content.',
  })
  @Get('mappings')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  listMappings(@Query() query: QueryMappingsDto) {
    return this.idMap.list(this.ctx.requireTenantId(), query);
  }
}
