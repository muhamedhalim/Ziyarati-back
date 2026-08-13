import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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

import { FileUploadService } from './file-upload.service';
import { CreateFileUploadDto } from './dto/create-file-upload.dto';
import { QueryFileUploadsDto } from './dto/query-file-uploads.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { NoEntitlementRequired } from '../subscription-billing/decorators/no-entitlement-required.decorator';

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
 * File upload metadata tracking. Guarded by PermissionsGuard + ActiveTenantGuard;
 * tenant id from TenantContext. No storage provider — metadata only.
 */
@ApiTags('Platform File Uploads')
@ApiBearerAuth('JWT-auth')
@NoEntitlementRequired()
@Controller('platform/files')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class FileUploadController {
  constructor(
    private readonly files: FileUploadService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Register upload metadata',
    description:
      '**Protected — `platform.files.manage`. Clinic active.** Records file metadata (name/url/type/size) + uploader. The binary lives in external storage.',
  })
  @ApiCreatedResponse({ description: 'File metadata registered.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `platform.files.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.PLATFORM_FILES_MANAGE)
  register(@Body() dto: CreateFileUploadDto) {
    return this.files.register(
      this.ctx.requireTenantId(),
      dto,
      this.ctx.getUser()?.id,
    );
  }

  @ApiOperation({
    summary: 'List uploaded files',
    description:
      '**Protected — `platform.files.read`. Clinic active.** Tenant-scoped, newest first, optional type filter + pagination.',
  })
  @ApiOkResponse({ description: 'Paginated file uploads.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `platform.files.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_FILES_READ)
  list(@Query() query: QueryFileUploadsDto) {
    return this.files.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Storage usage summary',
    description:
      '**Protected — `platform.files.read`. Clinic active.** Total files + bytes and a per-type breakdown for the tenant.',
  })
  @ApiOkResponse({ description: 'Storage usage.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `platform.files.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('usage')
  @RequirePermissions(PERMISSION.PLATFORM_FILES_READ)
  usage() {
    return this.files.storageUsage(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Get upload details',
    description:
      "**Protected — `platform.files.read`. Clinic active.** Another tenant's file returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'File UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'File metadata.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `platform.files.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'File not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_FILES_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Delete upload metadata',
    description:
      '**Protected — `platform.files.manage`. Clinic active.** Removes the metadata record (does not touch external storage).',
  })
  @ApiParam({
    name: 'id',
    description: 'File UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'File metadata deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `platform.files.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'File not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_FILES_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.files.remove(this.ctx.requireTenantId(), id);
  }
}
