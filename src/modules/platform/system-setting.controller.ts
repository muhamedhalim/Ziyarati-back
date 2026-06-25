import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { SystemSettingService } from './system-setting.service';
import { CreateSystemSettingDto } from './dto/create-system-setting.dto';
import { UpdateSystemSettingDto } from './dto/update-system-setting.dto';
import { QuerySystemSettingsDto } from './dto/query-system-settings.dto';
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
 * Two tiers:
 *  - Typed endpoints (`/typed`, `/registry`, `/by-key/:key`): operate on the
 *    known settings defined in SETTINGS_REGISTRY with schema validation.
 *  - Raw CRUD (`POST /`, `GET /`, `PATCH /:id`, `DELETE /:id`): legacy free-form
 *    KV access used by the advanced developer editor.
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
    description: 'Returns the full typed registry definition for all known settings.',
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
    description: 'Returns every registry-defined setting merged with its current DB value (or default).',
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
    description: 'Creates or updates a registry-defined setting. Value is validated against the registry schema.',
  })
  @ApiParam({ name: 'key', description: 'Setting key from the registry', type: 'string' })
  @ApiBody({ schema: { type: 'object', properties: { value: {} }, required: ['value'] } })
  @ApiOkResponse({ description: 'Setting upserted.' })
  @ApiUnauthorizedResponse({ schema: S_ERROR })
  @ApiForbiddenResponse({ schema: S_ERROR })
  @Put('by-key/:key')
  upsertByKey(@Param('key') key: string, @Body() dto: { value: unknown }) {
    if (!KNOWN_SETTING_KEYS.has(key)) {
      throw new BadRequestException(
        `Unknown setting key: "${key}". Use POST /platform/settings for raw keys.`,
      );
    }
    return this.settings.upsertByKey(key as SettingKey, dto.value);
  }

  // ────────────────────── Raw CRUD endpoints ──────────────────────────────  //

  @ApiOperation({ summary: 'Create a system setting (super admin)', description: '**Platform-only — SUPER ADMIN.** `key` is unique; `value` is any JSON.' })
  @ApiCreatedResponse({ description: 'Setting created.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not a super admin.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Setting key already exists.', schema: S_ERROR })
  @Post()
  create(@Body() dto: CreateSystemSettingDto) {
    return this.settings.create(dto);
  }

  @ApiOperation({ summary: 'List system settings (super admin)', description: '**Platform-only — SUPER ADMIN.** Optional key search + pagination.' })
  @ApiOkResponse({ description: 'Paginated settings.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not a super admin.', schema: S_ERROR })
  @Get()
  list(@Query() query: QuerySystemSettingsDto) {
    return this.settings.list(query);
  }

  @ApiOperation({ summary: 'Get a system setting (super admin)', description: '**Platform-only — SUPER ADMIN.**' })
  @ApiParam({ name: 'id', description: 'Setting UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Setting details.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not a super admin.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Setting not found.', schema: S_ERROR })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.settings.get(id);
  }

  @ApiOperation({ summary: 'Update a system setting (super admin)', description: '**Platform-only — SUPER ADMIN.** Update key and/or value.' })
  @ApiParam({ name: 'id', description: 'Setting UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Setting updated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not a super admin.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Setting not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Setting key already exists.', schema: S_ERROR })
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSystemSettingDto) {
    return this.settings.update(id, dto);
  }

  @ApiOperation({ summary: 'Delete a system setting (super admin)', description: '**Platform-only — SUPER ADMIN.**' })
  @ApiParam({ name: 'id', description: 'Setting UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Setting deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not a super admin.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Setting not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.settings.remove(id);
  }
}
