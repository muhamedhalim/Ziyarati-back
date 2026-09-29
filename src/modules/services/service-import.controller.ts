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

import { ServiceImportService } from './service-import.service';
import { SERVICE_IMPORT_MAX_BYTES } from './service-import.constants';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import type { UploadedFileLike } from '../storage/uploads.controller';
import type { MulterLimitsWithNestingDepth } from '../storage/storage.constants';

const IMPORT_UPLOAD_LIMITS: MulterLimitsWithNestingDepth = {
  fileSize: SERVICE_IMPORT_MAX_BYTES,
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
 * Bulk service-catalog import from an Excel (`.xlsx`) file. Import only ever
 * CREATES services, so it is gated by `services.create` — the same permission as
 * the manual "Add service" endpoint. Tenant id always from TenantContext; every
 * write goes through `ServiceService.create`.
 *
 * Registered BEFORE `ServiceController` in `ServicesModule` so the static
 * `services/import/*` paths are never shadowed by `services/:id`.
 */
@ApiTags('Services Import')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.SERVICES)
@Controller('services/import')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class ServiceImportController {
  constructor(
    private readonly importService: ServiceImportService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Download the services Excel import template',
    description:
      '**Protected — `services.create`. Clinic active.** A `.xlsx` with the expected header row, one example row and an instructions sheet.',
  })
  @ApiOkResponse({ description: 'Template file.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('template')
  @RequirePermissions(PERMISSION.SERVICES_CREATE)
  async downloadTemplate(@Res() res: Response): Promise<void> {
    const buffer = await this.importService.buildTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="service-import-template.xlsx"',
    );
    res.send(buffer);
  }

  @ApiOperation({
    summary: 'Preview + validate a services import file',
    description:
      "**Protected — `services.create`. Clinic active.** Parses the uploaded `.xlsx` and validates every row (the same rules as `POST /services`, plus duplicate-name checks within the file and against this tenant's catalog, and category-name resolution). Nothing is written. Max " +
      String(SERVICE_IMPORT_MAX_BYTES / 1024 / 1024) +
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
    description: 'Caller lacks `services.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post('preview')
  @RequirePermissions(PERMISSION.SERVICES_CREATE)
  @UseInterceptors(FileInterceptor('file', { limits: IMPORT_UPLOAD_LIMITS }))
  preview(@UploadedFile() file: UploadedFileLike | undefined) {
    return this.importService.validateFile(this.ctx.requireTenantId(), file);
  }

  @ApiOperation({
    summary: 'Import validated services',
    description:
      '**Protected — `services.create`. Clinic active.** Re-parses and re-validates the file (a prior `/preview` is never trusted), then creates every still-valid row through `ServiceService.create`. Invalid or conflicting rows are skipped and reported individually.',
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
    description: 'Caller lacks `services.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post('commit')
  @RequirePermissions(PERMISSION.SERVICES_CREATE)
  @UseInterceptors(FileInterceptor('file', { limits: IMPORT_UPLOAD_LIMITS }))
  commit(@UploadedFile() file: UploadedFileLike | undefined) {
    return this.importService.commit(this.ctx.requireTenantId(), file);
  }
}
