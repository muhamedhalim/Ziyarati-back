import { Body, Controller, Ip, Param, Post, UseGuards } from '@nestjs/common';
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
import { AppError, ErrorCode } from '../../../common/errors';

import { IntegrationImportService } from './integration-import.service';
import { BatchImportDto } from '../dto/batch-import.dto';
import {
  INTEGRATION_RESOURCE,
  isIntegrationResource,
} from '../integration-platform.constants';
import { RequireFeature } from '../../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';

/**
 * Tenant-admin synchronous batch import (Phase 3). The resource is a path param
 * validated against the fixed allowlist. Import reuses the shared write pipeline
 * and only supports resources whose write path exists (customers, services).
 *
 * NOTE: this bounded synchronous endpoint is retained for small operations; the
 * primary production flow is the async import-job pipeline (see imports.job.*).
 */
@ApiTags('Integration Imports')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/integrations')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationImportsController {
  constructor(
    private readonly imports: IntegrationImportService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Batch import a resource (synchronous, bounded)',
    description:
      '**Protected — `platform.integrations.manage`.** Bounded synchronous import (customers|services|staff). Supports `dryRun`. Returns per-record counts + safe errors.',
  })
  @ApiParam({
    name: 'resource',
    enum: [
      INTEGRATION_RESOURCE.CUSTOMER,
      INTEGRATION_RESOURCE.SERVICE,
      INTEGRATION_RESOURCE.STAFF,
    ],
  })
  @Post('imports/:resource')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  import(
    @Param('resource') resource: string,
    @Body() dto: BatchImportDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    if (!isIntegrationResource(resource)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Unknown resource type',
      });
    }
    return this.imports.import(this.ctx.requireTenantId(), resource, dto, {
      userId,
      ip,
    });
  }
}
