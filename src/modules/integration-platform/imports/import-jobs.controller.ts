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
import { AppError, ErrorCode } from '../../../common/errors';

import { IntegrationImportJobService } from './integration-import-job.service';
import { CreateImportJobDto } from '../dto/create-import-job.dto';
import { QueryJobsDto } from '../dto/query-jobs.dto';
import {
  INTEGRATION_RESOURCE,
  isIntegrationResource,
} from '../integration-platform.constants';
import { RequireFeature } from '../../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';

/**
 * Tenant-admin ASYNC import jobs (Phase 4) — the primary production import flow.
 * Create returns a tenant-facing job id immediately; progress/history/counts are
 * polled from these endpoints. Guarded by PermissionsGuard + ActiveTenantGuard.
 */
@ApiTags('Integration Import Jobs')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/integrations/import-jobs')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationImportJobsController {
  constructor(
    private readonly imports: IntegrationImportJobService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create an async import job',
    description:
      '**Protected — `platform.integrations.manage`.** Validates, enqueues, and returns a job id immediately. Supports `dryRun` (preview).',
  })
  @ApiParam({
    name: 'resource',
    enum: [
      INTEGRATION_RESOURCE.CUSTOMER,
      INTEGRATION_RESOURCE.SERVICE,
      INTEGRATION_RESOURCE.STAFF,
    ],
  })
  @Post(':resource')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  create(
    @Param('resource') resource: string,
    @Body() dto: CreateImportJobDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    if (!isIntegrationResource(resource)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Unknown resource type',
      });
    }
    return this.imports.create(this.ctx.requireTenantId(), resource, dto, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'List import jobs',
    description: '**Protected — `platform.integrations.read`.**',
  })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  list(@Query() query: QueryJobsDto) {
    return this.imports.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get import job status/progress',
    description: '**Protected — `platform.integrations.read`.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.getStatus(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'List per-item results',
    description:
      '**Protected — `platform.integrations.read`.** Safe fields only.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id/items')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  items(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.imports.listItems(
      this.ctx.requireTenantId(),
      id,
      page ? Math.max(1, parseInt(page, 10)) : 1,
      limit ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 50,
    );
  }

  @ApiOperation({
    summary: 'Cancel an import job',
    description:
      '**Protected — `platform.integrations.manage`.** Honored at the next item boundary.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.imports.cancel(this.ctx.requireTenantId(), id, { userId, ip });
  }

  @ApiOperation({
    summary: 'Retry failed items',
    description:
      '**Protected — `platform.integrations.manage`.** Re-enqueues the failed records.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.imports.retry(this.ctx.requireTenantId(), id, { userId, ip });
  }
}
