import {
  Controller,
  Get,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CustomerImportService } from './customer-import.service';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { UploadedFileLike } from '../storage/uploads.controller';
import { MulterLimitsWithNestingDepth } from '../storage/storage.constants';
import { CUSTOMER_IMPORT_MAX_BYTES } from './customer-import.constants';

/** ZT-004b-style hardening, same shape as the other multipart routes in CRM. */
const IMPORT_UPLOAD_LIMITS: MulterLimitsWithNestingDepth = {
  fileSize: CUSTOMER_IMPORT_MAX_BYTES,
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

const FILE_BODY_SCHEMA = {
  type: 'object' as const,
  required: ['file'],
  properties: {
    file: { type: 'string' as const, format: 'binary' as const },
  },
};

/**
 * Bulk customer import from an Excel (`.xlsx`) file. Guarded by
 * PermissionsGuard + ActiveTenantGuard; tenant id always from TenantContext.
 * Every write goes through `CustomerService.create` — same rules as the
 * manual "Add customer" endpoint, no separate storage path.
 */
@ApiTags('CRM Customer Import')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CRM)
@Controller('crm/customers/import')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class CustomerImportController {
  constructor(
    private readonly importService: CustomerImportService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Download the Excel import template',
    description:
      '**Protected — `crm.customers.manage`. Clinic active.** A `.xlsx` with the expected header row, one example row, and an instructions sheet.',
  })
  @ApiOkResponse({ description: 'Template file.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('template')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  async downloadTemplate(@Res() res: Response): Promise<void> {
    const buffer = await this.importService.buildTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="customer-import-template.xlsx"',
    );
    res.send(buffer);
  }

  @ApiOperation({
    summary: 'Preview + validate a customer import file',
    description:
      "**Protected — `crm.customers.manage`. Clinic active.** Parses the uploaded `.xlsx` and validates every row (the same rules as `POST /crm/customers`, plus duplicate email/ID-number checks — within the file and against this tenant's existing customers). Nothing is written to the database. Max " +
      String(CUSTOMER_IMPORT_MAX_BYTES / 1024 / 1024) +
      ' MB.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: FILE_BODY_SCHEMA })
  @ApiOkResponse({ description: 'Row-by-row validation preview.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post('preview')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: IMPORT_UPLOAD_LIMITS }))
  preview(@UploadedFile() file: UploadedFileLike | undefined) {
    return this.importService.validateFile(this.ctx.requireTenantId(), file);
  }

  @ApiOperation({
    summary: 'Import validated rows',
    description:
      '**Protected — `crm.customers.manage`. Clinic active.** Re-parses and re-validates the uploaded file (a prior `/preview` call is never trusted as-is), then creates every still-valid row through `CustomerService.create`. Invalid or conflicting rows are skipped and reported individually — one bad row never aborts the rest of the batch.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: FILE_BODY_SCHEMA })
  @ApiOkResponse({
    description: 'Import summary: imported/rejected counts and per-row errors.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `crm.customers.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post('commit')
  @RequirePermissions(PERMISSION.CRM_CUSTOMERS_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: IMPORT_UPLOAD_LIMITS }))
  commit(@UploadedFile() file: UploadedFileLike | undefined) {
    return this.importService.commit(this.ctx.requireTenantId(), file);
  }
}
