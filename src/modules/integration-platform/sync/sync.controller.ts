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

import { IntegrationSyncService } from './integration-sync.service';
import { StartSyncDto } from '../dto/start-sync.dto';
import { QueryJobsDto } from '../dto/query-jobs.dto';
import { RequireFeature } from '../../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';

/**
 * Tenant-admin synchronization dashboard (Phase 4). Start full/incremental syncs,
 * poll progress/cursor/history, and cancel/retry. Raw BullMQ ids are never
 * exposed — only the durable sync-run id. Guarded by PermissionsGuard +
 * ActiveTenantGuard.
 */
@ApiTags('Integration Sync')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/integrations/sync')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationSyncController {
  constructor(
    private readonly sync: IntegrationSyncService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Start a sync run',
    description:
      '**Protected — `platform.integrations.manage`.** Full (backfill) or incremental (resume from cursor). A DB constraint rejects a duplicate active run.',
  })
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  start(
    @Body() dto: StartSyncDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.sync.start(this.ctx.requireTenantId(), dto, { userId, ip });
  }

  @ApiOperation({
    summary: 'List sync runs (history)',
    description: '**Protected — `platform.integrations.read`.**',
  })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  list(@Query() query: QueryJobsDto) {
    return this.sync.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get a sync run',
    description: '**Protected — `platform.integrations.read`.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sync.getStatus(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Cancel a sync run',
    description:
      '**Protected — `platform.integrations.manage`.** Honored at the next page boundary.',
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
    return this.sync.cancel(this.ctx.requireTenantId(), id, { userId, ip });
  }

  @ApiOperation({
    summary: 'Retry/resume a sync run',
    description:
      '**Protected — `platform.integrations.manage`.** Starts a fresh run from the last successful cursor.',
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
    return this.sync.retry(this.ctx.requireTenantId(), id, { userId, ip });
  }
}
