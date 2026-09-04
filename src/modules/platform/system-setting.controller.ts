import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { SystemSettingService } from './system-setting.service';
import { UpsertTypedSettingDto } from './dto/upsert-typed-setting.dto';
import { KNOWN_SETTING_KEYS, SettingKey } from './settings.registry';

import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

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
 * PLATFORM-OWNED global system settings.
 *
 * SUPER ADMIN ONLY (RolesGuard). NOT tenant-scoped and never associated with a
 * tenant — these control platform-wide behavior. Tenants can never reach this
 * controller, so there is no TenantContext usage here.
 *
 * Typed endpoints only (`/typed`, `/registry`, `/by-key/:key`): operate on the
 * known settings defined in SETTINGS_REGISTRY with schema validation.
 */
@ApiTags('Platform System Settings')
@ApiBearerAuth('JWT-auth')
@Controller('platform/settings')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class SystemSettingController {
  constructor(private readonly settings: SystemSettingService) {}

  // ──────────────────── Typed setting endpoints ──────────────────────────── //

  @ApiOperation({
    summary: 'Get the settings registry (super admin)',
    description:
      'Returns the full typed registry definition for all known settings.',
  })
  @ApiOkResponse({ description: 'Registry definition.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Get('registry')
  getRegistry() {
    return this.settings.getRegistry();
  }

  @ApiOperation({
    summary: 'List all typed settings with current values (super admin)',
    description:
      'Returns every registry-defined setting merged with its current DB value (or default).',
  })
  @ApiOkResponse({ description: 'Typed settings list.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Get('typed')
  listTyped() {
    return this.settings.listTyped();
  }

  @ApiOperation({
    summary: 'Upsert a typed setting by key (super admin)',
    description:
      'Creates or updates a registry-defined setting. Value is validated against the registry schema.',
  })
  @ApiParam({
    name: 'key',
    description: 'Setting key from the registry',
    type: 'string',
  })
  @ApiBody({
    schema: { type: 'object', properties: { value: {} }, required: ['value'] },
  })
  @ApiOkResponse({ description: 'Setting upserted.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Put('by-key/:key')
  upsertByKey(@Param('key') key: string, @Body() dto: UpsertTypedSettingDto) {
    if (!KNOWN_SETTING_KEYS.has(key)) {
      throw new BadRequestException(`Unknown setting key: "${key}".`);
    }
    return this.settings.upsertByKey(key as SettingKey, dto.value);
  }
}
