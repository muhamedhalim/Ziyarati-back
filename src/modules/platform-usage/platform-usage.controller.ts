import {
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { PlatformUsageService } from './platform-usage.service';
import { UsageAuditService, USAGE_AUDIT_ACTION } from './usage-audit.service';
import { QueryTenantUsageDto } from './dto/query-tenant-usage.dto';
import { QueryTimelineDto } from './dto/query-timeline.dto';
import { PeriodMonthPipe } from './period-month.pipe';

import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Platform Usage dashboard — super-admin (platform owner) only.
 *
 * READ-ONLY, cross-tenant usage visibility. Per-metric quota numbers are served
 * from the Subscription Module (`UsageService.getBreakdown`) — this controller
 * never recomputes them. Views + exports are written to the shared audit trail.
 */
@ApiTags('Platform Usage (Platform)')
@ApiBearerAuth('JWT-auth')
@Controller('platform/usage')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformUsageController {
  constructor(
    private readonly usage: PlatformUsageService,
    private readonly audit: UsageAuditService,
  ) {}

  @ApiOperation({
    summary: 'Platform usage totals + alerts (super-admin)',
    description:
      'Platform-wide totals (AI tokens, API calls, storage, uploads, messages, bookings, customers, queue jobs, active tenants, over-limit and unlimited-plan counts) plus derived threshold/lifecycle alerts for the billing period.',
  })
  @ApiQuery({ name: 'periodMonth', required: false, example: '2026-07' })
  @ApiOkResponse({ description: 'Platform usage summary.' })
  @Get('summary')
  summary(@Query('periodMonth', PeriodMonthPipe) periodMonth?: string) {
    return this.usage.summary(periodMonth);
  }

  @ApiOperation({
    summary: 'Usage alerts across tenants (super-admin)',
    description:
      'Threshold (80/90/95/100%/exceeded) and subscription-lifecycle (expired/suspended/past-due) alerts, derived from the same subscription_usage vs plan data the quota system uses. Reusable by the notification system.',
  })
  @ApiOkResponse({ description: 'Ordered alert list (most severe first).' })
  @Get('alerts')
  alerts(@Query('periodMonth', PeriodMonthPipe) periodMonth?: string) {
    return this.usage.alerts(periodMonth);
  }

  @ApiOperation({
    summary: 'Executive platform insights (super-admin)',
    description:
      'Top-10 lists: storage / API / AI consumers, inactive clinics, dormant subscriptions, highest-cost tenants, and largest 30-day API/storage increases. Each is a single grouped query (no N+1).',
  })
  @ApiQuery({ name: 'periodMonth', required: false, example: '2026-07' })
  @ApiOkResponse({ description: 'Executive insights.' })
  @Get('insights')
  insights(@Query('periodMonth', PeriodMonthPipe) periodMonth?: string) {
    return this.usage.executiveInsights(periodMonth);
  }

  @ApiOperation({
    summary: 'Export tenant usage overview (super-admin)',
    description:
      'CSV (`format=csv`) or Excel/SpreadsheetML (`format=excel`) of the filtered tenant usage list. Audited.',
  })
  @ApiOkResponse({
    description: '{ filename, content, mimeType } download payload.',
  })
  @Get('export')
  async export(
    @Query() query: QueryTenantUsageDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.usage.export(query);
    await this.audit.record(USAGE_AUDIT_ACTION.EXPORT, userId, ip, undefined, {
      format: query.format,
      filters: { ...query },
    });
    return result;
  }

  @ApiOperation({
    summary: 'List tenant usage overview (super-admin)',
    description:
      'Server-paginated / filtered / sorted tenant list: plan, subscription + effective status, trial, enforcement, current period, renewal date, last activity and an overview utilisation. Per-metric numbers live in the tenant detail endpoint.',
  })
  @ApiOkResponse({ description: 'Paginated tenant usage rows.' })
  @Get()
  list(@Query() query: QueryTenantUsageDto) {
    return this.usage.listTenants(query);
  }

  @ApiOperation({
    summary: 'Platform-wide metric drill-down (super-admin)',
    description:
      'All-tenant drill-down for a totals card (`:metric`): aggregate used vs total finite quota plus hourly/daily/weekly/monthly time-series and a top-N breakdown. Powers the clickable platform summary cards.',
  })
  @ApiParam({
    name: 'metric',
    description: 'Metric key, e.g. aiTokens, apiCalls, storageBytes.',
  })
  @ApiQuery({ name: 'periodMonth', required: false, example: '2026-07' })
  @ApiOkResponse({ description: 'Platform-wide metric drill-down.' })
  @Get('metrics/:metric')
  async platformMetricDrilldown(
    @Param('metric') metric: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Query('periodMonth', PeriodMonthPipe) periodMonth?: string,
  ) {
    const result = await this.usage.platformMetricDrilldown(
      metric,
      periodMonth,
    );
    await this.audit.record(USAGE_AUDIT_ACTION.VIEW, userId, ip, undefined, {
      metric,
      scope: 'platform',
    });
    return result;
  }

  @ApiOperation({
    summary: 'Tenant usage detail grid (super-admin)',
    description:
      'Every metric for one tenant with used / plan limit / remaining / percentage / exceeded / unlimited and a status band. Quota metrics come from `UsageService.getBreakdown()` (single source); count/activity metrics from their owning tables. View is audited.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiQuery({ name: 'periodMonth', required: false, example: '2026-07' })
  @ApiOkResponse({ description: 'Tenant usage detail.' })
  @Get(':tenantId')
  async tenantDetail(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Query('periodMonth', PeriodMonthPipe) periodMonth?: string,
  ) {
    const result = await this.usage.tenantDetail(tenantId, periodMonth);
    await this.audit.record(USAGE_AUDIT_ACTION.VIEW, userId, ip, tenantId);
    return result;
  }

  @ApiOperation({
    summary: 'Upgrade recommendation for a tenant (super-admin)',
    description:
      'Smart plan recommendation (PART 2): reuses the resolved quota lines + the plan catalogue to pick the cheapest higher plan that clears every pressured resource. Includes current/recommended plan, reason, blocked resources, expected benefits and estimated monthly increase. No limit is hardcoded.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiQuery({ name: 'periodMonth', required: false })
  @ApiOkResponse({ description: 'Upgrade recommendation.' })
  @Get(':tenantId/recommendation')
  async recommendation(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Query('periodMonth', PeriodMonthPipe) periodMonth?: string,
  ) {
    const result = await this.usage.recommendUpgrade(tenantId, periodMonth);
    await this.audit.record(USAGE_AUDIT_ACTION.VIEW, userId, ip, tenantId, {
      view: 'recommendation',
    });
    return result;
  }

  @ApiOperation({
    summary: 'Tenant usage history timeline (super-admin)',
    description:
      'Per-tenant timeline (PART 3): a live quota-state snapshot plus paginated / filtered / searchable history from the shared audit log. View is audited.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiOkResponse({
    description: 'Timeline (current snapshot + paginated history).',
  })
  @Get(':tenantId/timeline')
  async timeline(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: QueryTimelineDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const result = await this.usage.tenantTimeline(tenantId, query);
    await this.audit.record(USAGE_AUDIT_ACTION.VIEW, userId, ip, tenantId, {
      view: 'timeline',
    });
    return result;
  }

  @ApiOperation({
    summary: 'Per-metric usage drill-down (super-admin)',
    description:
      'Drill-down for one metric of one tenant: authoritative headline (from getBreakdown for quota metrics) plus daily/monthly time-series and a top-N breakdown where the underlying table supports it.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiParam({
    name: 'metric',
    description: 'Metric key, e.g. aiTokens, apiCalls, storageBytes.',
  })
  @ApiQuery({ name: 'periodMonth', required: false, example: '2026-07' })
  @ApiOkResponse({ description: 'Metric drill-down with charts.' })
  @Get(':tenantId/:metric')
  async metricDrilldown(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('metric') metric: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
    @Query('periodMonth', PeriodMonthPipe) periodMonth?: string,
  ) {
    const result = await this.usage.metricDrilldown(
      tenantId,
      metric,
      periodMonth,
    );
    await this.audit.record(USAGE_AUDIT_ACTION.VIEW, userId, ip, tenantId, {
      metric,
    });
    return result;
  }
}
