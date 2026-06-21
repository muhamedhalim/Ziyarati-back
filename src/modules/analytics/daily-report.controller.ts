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

import { DailyReportService } from './daily-report.service';
import { GenerateDailyReportDto } from './dto/generate-daily-report.dto';
import { QueryDailyReportsDto } from './dto/query-daily-reports.dto';

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
 * Daily reports. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id from
 * TenantContext. Generation is a precompute (`analytics.reports.manage`); reads
 * require `analytics.reports.read`.
 */
@ApiTags('Analytics Daily Reports')
@ApiBearerAuth('JWT-auth')
@Controller('analytics/reports/daily')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class DailyReportController {
  constructor(
    private readonly reports: DailyReportService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Generate a daily report',
    description: '**Protected — `analytics.reports.manage`. Clinic active.** Precomputes (or recomputes) the day\'s report. With `branchId` → one branch; without → all active branches (batch). 422 if no active branches.',
  })
  @ApiOkResponse({ description: 'Report(s) generated.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.reports.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Branch not found in this tenant.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'No active branches to report on.', schema: S_ERROR })
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.ANALYTICS_REPORTS_MANAGE)
  generate(@Body() dto: GenerateDailyReportDto) {
    return this.reports.generate(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List daily reports',
    description: '**Protected — `analytics.reports.read`. Clinic active.** Tenant-scoped, newest first, with branch/date filters + pagination. All fields are strictly BRANCH-scoped: `*_appointments`, `total_revenue`, and `ai_messages_count` (AI messages whose conversation belongs to the branch). `new_customers` is always 0 — customer acquisition is not branch-attributable and is excluded from branch reports; tenant-level customer/AI totals live on the dashboard.',
  })
  @ApiOkResponse({ description: 'Paginated daily reports.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.reports.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.ANALYTICS_REPORTS_READ)
  list(@Query() query: QueryDailyReportsDto) {
    return this.reports.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get a daily report',
    description: '**Protected — `analytics.reports.read`. Clinic active.** Another tenant\'s report returns 404. All fields are branch-scoped (appointments, revenue, branch-linked `ai_messages_count`); `new_customers` is 0 (not branch-attributable — see the tenant dashboard).',
  })
  @ApiParam({ name: 'id', description: 'Daily report UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Daily report.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.reports.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Report not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.ANALYTICS_REPORTS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.get(this.ctx.requireTenantId(), id);
  }
}
