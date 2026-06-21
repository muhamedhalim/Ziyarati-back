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

import { CustomerFileService } from './customer-file.service';
import { CreateCustomerFileDto } from './dto/create-customer-file.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';

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

  @ApiOperation({ summary: 'Register an uploaded file (metadata)', description: '**Protected — `crm.files.manage`. Clinic active.** Stores file metadata (name/url/type) + uploader; binary lives in external storage.' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'File metadata stored.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.files.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.CRM_FILES_MANAGE)
  upload(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerFileDto,
  ) {
    return this.files.upload(
      this.ctx.requireTenantId(),
      customerId,
      dto,
      this.ctx.getUser()?.id,
    );
  }

  @ApiOperation({ summary: 'List files', description: '**Protected — `crm.files.read`. Clinic active.** Tenant + customer scoped, newest first, paginated.' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Paginated files.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.files.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Customer not found in this tenant.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.CRM_FILES_READ)
  list(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.files.list(this.ctx.requireTenantId(), customerId, query);
  }

  @ApiOperation({ summary: 'Get file metadata (download)', description: '**Protected — `crm.files.read`. Clinic active.** Returns metadata incl. `file_url`. Another tenant\'s file returns 404.' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'fileId', description: 'File UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'File metadata.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.files.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'File not found in this tenant.', schema: S_ERROR })
  @Get(':fileId')
  @RequirePermissions(PERMISSION.CRM_FILES_READ)
  getMetadata(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    return this.files.getMetadata(this.ctx.requireTenantId(), customerId, fileId);
  }

  @ApiOperation({ summary: 'Delete a file', description: '**Protected — `crm.files.manage`. Clinic active.** Removes the metadata record.' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'fileId', description: 'File UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'File deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `crm.files.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'File not found in this tenant.', schema: S_ERROR })
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
