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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CustomerFileService } from './customer-file.service';
import { UploadCustomerFileDto } from './dto/upload-customer-file.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import {
  MAX_UPLOAD_BYTES,
  MulterLimitsWithNestingDepth,
} from '../storage/storage.constants';
import { UploadedFileLike } from '../storage/uploads.controller';
import { AppError, ErrorCode } from '../../common/errors';

/** ZT-004b: bounds field-name nesting depth and non-file field count. */
const UPLOAD_LIMITS: MulterLimitsWithNestingDepth = {
  fileSize: MAX_UPLOAD_BYTES,
  fieldNestingDepth: 5,
  fields: 10,
};

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
 * Customer files (metadata only). Guarded by PermissionsGuard + ActiveTenantGuard;
 * tenant id from TenantContext. The uploader is taken from the principal.
 */
@ApiTags('CRM Customer Files')
@ApiBearerAuth('JWT-auth')
@Controller('crm/customers/:customerId/files')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CustomerFileController {
  constructor(
    private readonly files: CustomerFileService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Upload a file for a customer',
    description:
      '**Protected — `crm.files.manage`. Clinic active.** Streams a `multipart/form-data` file to private R2 storage (same allow-list/magic-byte validation as staff avatars and verification documents: PDF, PNG, JPEG, WEBP, 10 MB max) and stores its metadata against the customer. The binary is never stored locally or in the database.',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        fileName: { type: 'string', example: 'Lab result — 2026-06-01' },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'File uploaded and linked to the customer.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.files.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.CRM_FILES_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS }))
  upload(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() dto: UploadCustomerFileDto,
  ) {
    if (!file) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'No file uploaded. Send the file under the field name "file".',
      });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
      });
    }

    return this.files.upload(
      this.ctx.requireTenantId(),
      customerId,
      {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        buffer: file.buffer,
        fileName: dto.fileName,
      },
      this.ctx.getUser()?.id,
    );
  }

  @ApiOperation({
    summary: 'List files',
    description:
      '**Protected — `crm.files.read`. Clinic active.** Tenant + customer scoped, newest first, paginated.',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Paginated files.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.files.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Customer not found in this tenant.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.CRM_FILES_READ)
  list(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.files.list(this.ctx.requireTenantId(), customerId, query);
  }

  @ApiOperation({
    summary: 'Get file metadata (download)',
    description:
      "**Protected — `crm.files.read`. Clinic active.** Returns metadata incl. `file_url`. Another tenant's file returns 404.",
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'fileId',
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
    description: 'Caller lacks `crm.files.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'File not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':fileId')
  @RequirePermissions(PERMISSION.CRM_FILES_READ)
  getMetadata(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    return this.files.getMetadata(
      this.ctx.requireTenantId(),
      customerId,
      fileId,
    );
  }

  @ApiOperation({
    summary: 'Delete a file',
    description:
      '**Protected — `crm.files.manage`. Clinic active.** Removes the metadata record and best-effort deletes the underlying R2 object.',
  })
  @ApiParam({
    name: 'customerId',
    description: 'Customer UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'fileId',
    description: 'File UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'File deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.files.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'File not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete(':fileId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CRM_FILES_MANAGE)
  remove(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    return this.files.remove(this.ctx.requireTenantId(), customerId, fileId);
  }
}
