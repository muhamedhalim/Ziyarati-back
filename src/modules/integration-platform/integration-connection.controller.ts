import {
  Body,
  Controller,
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
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

import { IntegrationConnectionService } from './integration-connection.service';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { UpdateConnectionDto } from './dto/update-connection.dto';
import { QueryConnectionsDto } from './dto/query-connections.dto';

/**
 * Tenant-admin management of external-system connections (Phase 3). Guarded by
 * PermissionsGuard + ActiveTenantGuard; tenant id from TenantContext. Encrypted
 * credentials are NEVER returned — only `hasCredential`.
 */
@ApiTags('Integration Connections')
@ApiBearerAuth('JWT-auth')
@Controller('platform/integrations/connections')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationConnectionController {
  constructor(
    private readonly connections: IntegrationConnectionService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Register a connection', description: '**Protected — `platform.integrations.manage`.**' })
  @Post()
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  create(@Body() dto: CreateConnectionDto, @CurrentUser('id') userId: string, @Ip() ip: string) {
    return this.connections.create(this.ctx.requireTenantId(), dto, { userId, ip });
  }

  @ApiOperation({ summary: 'List connections', description: '**Protected — `platform.integrations.read`.**' })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  list(@Query() query: QueryConnectionsDto) {
    return this.connections.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({ summary: 'Get a connection', description: '**Protected — `platform.integrations.read`.**' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.connections.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Connection health/status', description: '**Protected — `platform.integrations.read`.**' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get(':id/health')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  health(@Param('id', ParseUUIDPipe) id: string) {
    return this.connections.health(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Update a connection', description: '**Protected — `platform.integrations.manage`.**' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Patch(':id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConnectionDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.connections.update(this.ctx.requireTenantId(), id, dto, { userId, ip });
  }

  @ApiOperation({ summary: 'Activate a connection', description: '**Protected — `platform.integrations.manage`.**' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  activate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string, @Ip() ip: string) {
    return this.connections.setActive(this.ctx.requireTenantId(), id, true, { userId, ip });
  }

  @ApiOperation({ summary: 'Deactivate a connection', description: '**Protected — `platform.integrations.manage`.**' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string, @Ip() ip: string) {
    return this.connections.setActive(this.ctx.requireTenantId(), id, false, { userId, ip });
  }

  @ApiOperation({
    summary: 'Disconnect a connection',
    description: '**Protected — `platform.integrations.manage`.** Clears credentials and hides it; mappings/history are preserved.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  disconnect(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string, @Ip() ip: string) {
    return this.connections.disconnect(this.ctx.requireTenantId(), id, { userId, ip });
  }
}
