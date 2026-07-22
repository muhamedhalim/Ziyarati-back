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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { QueryApiKeysDto } from './dto/query-api-keys.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

/**
 * API keys for external integrations. Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext. The plaintext key is returned
 * ONLY by create/rotate and never again; `key_hash` is never exposed.
 */
@ApiTags('Platform API Keys')
@ApiBearerAuth('JWT-auth')
@Controller('platform/api-keys')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class ApiKeyController {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Create an API key', description: '**Protected — `platform.api-keys.manage`. Clinic active.** Returns the plaintext key ONCE (store it now — it cannot be retrieved later).' })
  @ApiCreatedResponse({ description: 'API key created (plaintext returned once).' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.api-keys.manage`, or clinic inactive.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.PLATFORM_API_KEYS_MANAGE)
  create(
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.keys.create(this.ctx.requireTenantId(), dto, {
      userId: user.id,
      permissions: user.permissions,
      isSuperAdmin: user.roles.includes(ROLE.SUPER_ADMIN),
      ip,
    });
  }

  @ApiOperation({ summary: 'List API keys', description: '**Protected — `platform.api-keys.read`. Clinic active.** Tenant-scoped; secrets never included.' })
  @ApiOkResponse({ description: 'Paginated API keys (no secrets).' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.api-keys.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_API_KEYS_READ)
  list(@Query() query: QueryApiKeysDto) {
    return this.keys.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({ summary: 'Get API key details', description: '**Protected — `platform.api-keys.read`. Clinic active.** Another tenant\'s key returns 404. Secret not included.' })
  @ApiParam({ name: 'id', description: 'API key UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'API key details (no secret).' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.api-keys.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'API key not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_API_KEYS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.keys.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Rotate an API key', description: '**Protected — `platform.api-keys.manage`. Clinic active.** Issues a new secret (returned once); the old secret stops working.' })
  @ApiParam({ name: 'id', description: 'API key UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'API key rotated (new plaintext returned once).' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.api-keys.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'API key not found in this tenant.', schema: S_ERROR })
  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_API_KEYS_MANAGE)
  rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.keys.rotate(this.ctx.requireTenantId(), id, { userId, ip });
  }

  @ApiOperation({ summary: 'Revoke an API key (permanent)', description: '**Protected — `platform.api-keys.manage`. Clinic active.** Permanently disables the key (inactive + expired).' })
  @ApiParam({ name: 'id', description: 'API key UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'API key revoked.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.api-keys.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'API key not found in this tenant.', schema: S_ERROR })
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_API_KEYS_MANAGE)
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.keys.revoke(this.ctx.requireTenantId(), id, { userId, ip });
  }

  @ApiOperation({ summary: 'Activate an API key', description: '**Protected — `platform.api-keys.manage`. Clinic active.** Re-enables a deactivated key.' })
  @ApiParam({ name: 'id', description: 'API key UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'API key activated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.api-keys.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'API key not found in this tenant.', schema: S_ERROR })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_API_KEYS_MANAGE)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.keys.activate(this.ctx.requireTenantId(), id, { userId, ip });
  }

  @ApiOperation({ summary: 'Deactivate an API key', description: '**Protected — `platform.api-keys.manage`. Clinic active.** Temporarily disables the key (reversible via activate).' })
  @ApiParam({ name: 'id', description: 'API key UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'API key deactivated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.api-keys.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'API key not found in this tenant.', schema: S_ERROR })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_API_KEYS_MANAGE)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.keys.deactivate(this.ctx.requireTenantId(), id, { userId, ip });
  }
}
