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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../../core/tenant-context/active-tenant.guard';

import { IntegrationIdMapService } from './integration-id-map.service';
import {
  IntegrationAuditService,
  INTEGRATION_AUDIT_ACTION,
} from '../integration-audit.service';
import { QueryMappingsDto } from '../dto/query-mappings.dto';
import { RelinkMappingDto } from '../dto/relink-mapping.dto';
import { RequireFeature } from '../../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';

/**
 * Tenant-admin viewer + lifecycle for external-id ⇄ internal-id mappings
 * (Phase 3/4). Ids only — never record content. Guarded by PermissionsGuard +
 * ActiveTenantGuard; the tenant id comes from TenantContext.
 *
 * Unlink is a SOFT operation: the row is retained so import/sync history,
 * conflicts and audit entries keep resolving, and a later reconnect can reuse
 * the original correspondence rather than re-importing into a duplicate record.
 */
@ApiTags('Integration Mappings')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/integrations')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationMappingsController {
  constructor(
    private readonly idMap: IntegrationIdMapService,
    private readonly audit: IntegrationAuditService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List external-id mappings',
    description:
      '**Protected — `platform.integrations.read`.** Ids only; never record content. Supports pagination, connection/resource filters, exact-id lookup, free-text search across both ids, and `scope=active|unlinked|all`.',
  })
  @Get('mappings')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  listMappings(@Query() query: QueryMappingsDto) {
    return this.idMap.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Unlink a mapping',
    description:
      '**Protected — `platform.integrations.manage`.** SOFT unlink — the internal record is untouched and the mapping row is retained for history and reconnect reuse. The external id and the internal record become mappable again immediately.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post('mappings/:id/unlink')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  async unlink(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const m = await this.idMap.unlink(tenantId, id);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.MAPPING_UNLINK,
      tenantId,
      m.resource_type,
      id,
      { userId, ip },
      {
        connectionId: m.connection?.id ?? null,
        externalId: m.external_id,
        internalResourceId: m.internal_resource_id,
      },
    );
    return { unlinked: true, id };
  }

  @ApiOperation({
    summary: 'Relink a mapping',
    description:
      '**Protected — `platform.integrations.manage`.** Re-activates an unlinked mapping, optionally pointing it at a different internal record. Both sides are re-checked: a live mapping on either side is a 409, never a silent overwrite.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post('mappings/:id/relink')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  async relink(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RelinkMappingDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const m = await this.idMap.relink(tenantId, id, dto.internalResourceId);
    await this.audit.record(
      INTEGRATION_AUDIT_ACTION.MAPPING_RELINK,
      tenantId,
      m.resource_type,
      id,
      { userId, ip },
      {
        connectionId: m.connection?.id ?? null,
        externalId: m.external_id,
        internalResourceId: m.internal_resource_id,
        retargeted: !!dto.internalResourceId,
      },
    );
    return { relinked: true, id, internalResourceId: m.internal_resource_id };
  }
}
