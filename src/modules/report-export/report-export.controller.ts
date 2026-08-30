import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateReportExportDto } from './dto/create-report-export.dto';
import { ReportExportService } from './report-export.service';
import { EXPORT_REGISTRY, EXPORT_REGISTRY_KEYS } from './export-registry';

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
 * Spec 014 (Clinic Platform Completion) — T184 (US13, contracts/
 * clinic-surfaces.md F13). The four report-export routes.
 *
 * `reports.export` (`PERMISSION.REPORTS_EXPORT`) — the slug that has
 * existed, been granted to live roles, and been enforced NOWHERE — is
 * enforced here for the first time (R14 / T004's own justification: its
 * removal from `UNTRIAGED_COVERAGE_GAP_SLUGS` is only correct once a real
 * route enforces it, and this is that route).
 */
@ApiTags('Report Export')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.ANALYTICS)
@Controller('reports/export')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class ReportExportController {
  constructor(
    private readonly exports: ReportExportService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Request a report export',
    description:
      '**Protected — `reports.export`.** Returns the file directly (200) below the sync row threshold; ' +
      '`202 { jobId }` above it (T183 generates it in the background).',
  })
  @ApiOkResponse({ description: 'The export file (below the sync threshold).' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `reports.export`.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.REPORTS_EXPORT)
  async create(@Body() dto: CreateReportExportDto, @Res() res: Response) {
    const tenantId = this.ctx.requireTenantId();
    const user = this.ctx.getUser();
    if (!user) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'An authenticated user is required',
      });
    }
    const result = await this.exports.requestExport(tenantId, user, dto);

    if (result.kind === 'async') {
      res.status(HttpStatus.ACCEPTED).json({ jobId: result.jobId });
      return;
    }

    // `@Res()` WITHOUT `passthrough` — Nest's own default reply strategy
    // treats a returned Buffer as a plain object and JSON-serialises it
    // (`{"type":"Buffer","data":[...]}`), corrupting the file. Full manual
    // control via `res.send(Buffer)` is the only way to hand back real
    // binary bytes.
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    res.send(result.buffer);
  }

  @ApiOperation({
    summary: 'The closed registry of exportable reports',
    description:
      '**Protected — `reports.export`.** Each entry names its label and its supported formats (FR-X003).',
  })
  @ApiOkResponse({ description: 'The exportable report catalogue.' })
  @Get('reports')
  @RequirePermissions(PERMISSION.REPORTS_EXPORT)
  listReports() {
    return EXPORT_REGISTRY_KEYS.map((key) => {
      const entry = EXPORT_REGISTRY[key];
      return { key: entry.key, label: entry.label, formats: entry.formats };
    });
  }

  @ApiOperation({
    summary: 'Export job status',
    description:
      "**Protected — `reports.export`.** Another tenant's export id returns the same 404 as an unknown one.",
  })
  @ApiParam({ name: 'jobId', format: 'uuid' })
  @ApiOkResponse({ description: 'Export job status.' })
  @ApiNotFoundResponse({
    description: 'Unknown or cross-tenant export id.',
    schema: S_ERROR,
  })
  @Get(':jobId')
  @RequirePermissions(PERMISSION.REPORTS_EXPORT)
  async getStatus(@Param('jobId', ParseUUIDPipe) jobId: string) {
    const tenantId = this.ctx.requireTenantId();
    return this.exports.getStatus(tenantId, jobId);
  }

  @ApiOperation({
    summary: 'Download a ready export',
    description:
      '**Protected — `reports.export`.** 302 to a short-lived signed URL once READY; 202 `{ state }` while ' +
      "still preparing; 409 `{ code, state }` once EXPIRED or FAILED; 404 for an unknown or another tenant's job id.",
  })
  @ApiParam({ name: 'jobId', format: 'uuid' })
  @ApiOkResponse({
    description:
      'Redirects to a signed download URL, or reports a pending state.',
  })
  @ApiConflictResponse({
    description: 'Export EXPIRED or FAILED.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or cross-tenant export id.',
    schema: S_ERROR,
  })
  @Get(':jobId/download')
  @RequirePermissions(PERMISSION.REPORTS_EXPORT)
  async download(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Res() res: Response,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const result = await this.exports.getDownload(tenantId, jobId);
    if (result.pending) {
      res.status(HttpStatus.ACCEPTED).json({ state: result.state });
      return;
    }
    res.redirect(HttpStatus.FOUND, result.url);
  }
}
