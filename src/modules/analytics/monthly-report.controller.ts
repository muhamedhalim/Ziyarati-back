import {
  Body,
  Controller,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { MonthlyReportService } from './monthly-report.service';
import { GenerateMonthlyReportDto } from './dto/generate-monthly-report.dto';
import { QueryMonthlyReportsDto } from './dto/query-monthly-reports.dto';

import { AdvancedAnalyticsService } from './advanced-analytics.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

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
 * Monthly reports. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id
 * from TenantContext. Generation is a precompute (`analytics.reports.manage`);
 * reads require `analytics.reports.read`.
 */
@ApiTags('Analytics Monthly Reports')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.ANALYTICS)
@Controller('analytics/reports/monthly')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class MonthlyReportController {
  constructor(
    private readonly reports: MonthlyReportService,
    private readonly ctx: TenantContextService,
    private readonly advanced: AdvancedAnalyticsService,
  ) {}

  @ApiOperation({
    summary: 'Generate a monthly report',
    description:
      "**Protected — `analytics.reports.manage`. Clinic active.** Aggregates the month's daily reports (totals) + computes rating/top-services from source. With `branchId` → one branch; without → all active branches (batch).",
  })
  @ApiOkResponse({ description: 'Report(s) generated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `analytics.reports.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Branch not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'No active branches to report on.',
    schema: S_ERROR,
  })
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.ANALYTICS_REPORTS_MANAGE)
  generate(@Body() dto: GenerateMonthlyReportDto) {
    return this.reports.generate(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List monthly reports',
    description:
      '**Protected — `analytics.reports.read`. Clinic active.** Tenant-scoped, newest first, with branch/month filters + pagination.',
  })
  @ApiOkResponse({ description: 'Paginated monthly reports.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `analytics.reports.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.ANALYTICS_REPORTS_READ)
  async list(
    @Query() query: QueryMonthlyReportsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const tenantId = this.ctx.requireTenantId();
    // FR-A016 — a branch-restricted caller only ever sees their own branch.
    const scope = await this.advanced.resolveScope(
      tenantId,
      user,
      query.branchId,
    );
    return this.reports.list(tenantId, { ...query, branchId: scope.branchId });
  }

  @ApiOperation({
    summary: 'Get a monthly report',
    description:
      "**Protected — `analytics.reports.read`. Clinic active.** Another tenant's report returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Monthly report UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Monthly report.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `analytics.reports.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Report not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.ANALYTICS_REPORTS_READ)
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const report = await this.reports.get(tenantId, id);
    await this.advanced.assertBranchVisible(tenantId, user, report.branch?.id);
    return report;
  }
}
