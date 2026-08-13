import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
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

import { IntegrationConnectionService } from './integration-connection.service';
import { IntegrationConnectionTestService } from './connection-test.service';
import { CreateConnectionDto } from '../dto/create-connection.dto';
import { UpdateConnectionDto } from '../dto/update-connection.dto';
import { QueryConnectionsDto } from '../dto/query-connections.dto';
import { ReconnectConnectionDto } from '../dto/relink-mapping.dto';
import { TestConnectionDto } from '../dto/test-connection.dto';
import { RotateConnectionAuthDto } from '../dto/rotate-connection-auth.dto';
import { RequireFeature } from '../../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';

/**
 * Tenant-admin management of external-system connections (Phase 3). Guarded by
 * PermissionsGuard + ActiveTenantGuard; tenant id from TenantContext. Encrypted
 * credentials are NEVER returned — only `hasCredential`.
 */
@ApiTags('Integration Connections')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/integrations/connections')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationConnectionController {
  constructor(
    private readonly connections: IntegrationConnectionService,
    private readonly connectionTest: IntegrationConnectionTestService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Register a connection',
    description: '**Protected — `platform.integrations.manage`.**',
  })
  @Post()
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  create(
    @Body() dto: CreateConnectionDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.create(this.ctx.requireTenantId(), dto, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Test an unsaved (or partially edited) connection draft',
    description:
      '**Protected — `platform.integrations.manage`.** Real outbound probe with SSRF protection, a bounded timeout and response size — nothing is persisted. Static route (declared before `:id`).',
  })
  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  testConnection(
    @Body() dto: TestConnectionDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connectionTest.test(this.ctx.requireTenantId(), dto, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'List connections',
    description: '**Protected — `platform.integrations.read`.**',
  })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  list(@Query() query: QueryConnectionsDto) {
    return this.connections.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'List providers + capabilities',
    description:
      '**Protected — `platform.integrations.read`.** Static route (declared before `:id`).',
  })
  @Get('providers')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  providers() {
    return this.connections.listProviders();
  }

  @ApiOperation({
    summary: 'Get a connection',
    description: '**Protected — `platform.integrations.read`.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.connections.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Connection health/status',
    description:
      '**Protected — `platform.integrations.read`.** Derived state, never row existence.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id/health')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  health(@Param('id', ParseUUIDPipe) id: string) {
    return this.connections.health(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Run a live health probe',
    description:
      '**Protected — `platform.integrations.manage`.** Calls the provider adapter; records latency + failure.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/health/check')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  checkHealth(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.checkHealth(this.ctx.requireTenantId(), id, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Update a connection',
    description: '**Protected — `platform.integrations.manage`.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Patch(':id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConnectionDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.update(this.ctx.requireTenantId(), id, dto, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Activate a connection',
    description: '**Protected — `platform.integrations.manage`.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.setActive(this.ctx.requireTenantId(), id, true, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Deactivate a connection',
    description: '**Protected — `platform.integrations.manage`.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.setActive(this.ctx.requireTenantId(), id, false, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Disconnect a connection',
    description:
      '**Protected — `platform.integrations.manage`.** Clears credentials and hides it; mappings/history are preserved.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  disconnect(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.disconnect(this.ctx.requireTenantId(), id, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Reconnect a disconnected connection',
    description:
      '**Protected — `platform.integrations.manage`.** Restores the connection in place (a credential must be supplied again — disconnect destroys the stored secret), or, with `replacementConnectionId`, carries its active mappings over to a replacement connection. Nothing is deleted either way.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/reconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  reconnect(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReconnectConnectionDto & { credential?: string },
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.reconnect(
      this.ctx.requireTenantId(),
      id,
      {
        replacementConnectionId: dto.replacementConnectionId,
        credential: dto.credential,
      },
      { userId, ip },
    );
  }

  @ApiOperation({
    summary: 'Rotate authentication (change auth type or credentials) safely',
    description:
      "**Protected — `platform.integrations.manage`.** Auth type is immutable on an existing connection, so this creates a REPLACEMENT connection with the new auth type/credential, transfers this connection's active mappings onto it, and retires (disconnects — never deletes) the original. Nothing is destroyed.",
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/rotate-auth')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  rotateAuth(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RotateConnectionAuthDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.rotateAuth(this.ctx.requireTenantId(), id, dto, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Preview what a permanent delete would destroy',
    description:
      '**Protected — `platform.integrations.read`.** Shows the retention impact (mapping counts, what survives, what is destroyed) so the consequence is explicit before confirming.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id/purge-impact')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  purgeImpact(@Param('id', ParseUUIDPipe) id: string) {
    return this.connections.purgeImpact(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Permanently delete a disconnected connection',
    description:
      '**Protected — `platform.integrations.manage`.** HARD delete: removes the connection and CASCADES its external-id mappings. Only permitted once the connection is already disconnected. Import/sync/conflict/inbound history and audit records survive (their connection reference is nulled). Audited with the retention impact.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Delete(':id/purge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  purge(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.purge(this.ctx.requireTenantId(), id, {
      userId,
      ip,
    });
  }
}
