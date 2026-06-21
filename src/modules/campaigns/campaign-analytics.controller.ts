import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CampaignAnalyticsService } from './campaign-analytics.service';
import { CampaignAnalyticsFilterDto } from './dto/campaign-analytics-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';

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

const S_DASHBOARD = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    totalCampaigns: { type: 'number', example: 24 },
    campaignsByStatus: { type: 'object', additionalProperties: { type: 'number' }, example: { DRAFT: 3, RUNNING: 2, COMPLETED: 18 } },
    totalRecipients: { type: 'number', example: 12500 },
    deliveredCount: { type: 'number', example: 11800 },
    failedCount: { type: 'number', example: 320 },
    deliveryRate: { type: 'number', example: 94.4 },
    recipientsByStatus: { type: 'object', additionalProperties: { type: 'number' } },
  },
};

const S_PERFORMANCE = {
  type: 'object',
  properties: {
    campaignId: { type: 'string', format: 'uuid' },
    totalRecipients: { type: 'number', example: 540 },
    deliveredCount: { type: 'number', example: 500 },
    failedCount: { type: 'number', example: 20 },
    processedCount: { type: 'number', example: 540 },
    deliveryRate: { type: 'number', example: 92.59 },
    completionRate: { type: 'number', example: 100 },
    byStatus: { type: 'object', additionalProperties: { type: 'number' } },
  },
};

/**
 * Campaign reporting & analytics. Guarded by PermissionsGuard +
 * ActiveTenantGuard. All aggregates are tenant-scoped (campaign queries filter
 * the tenant; recipient aggregates join through `campaign.tenant`).
 */
@ApiTags('Campaign Analytics')
@ApiBearerAuth('JWT-auth')
@Controller('campaign-analytics')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('campaigns')
export class CampaignAnalyticsController {
  constructor(
    private readonly analytics: CampaignAnalyticsService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Campaign summary dashboard',
    description: `
**Protected — requires \`campaign_analytics.read\`. Clinic must be active.**

Tenant-wide overview: campaign counts by status, total recipients, aggregate
delivered/failed and overall delivery rate. Powers the marketing dashboard.

**Who can call this:** Owner, Manager, Receptionist (\`campaign_analytics.read\`).

**Tenant scoping:** Only the caller's campaigns/recipients are aggregated.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Dashboard metrics.', schema: S_DASHBOARD })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaign_analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('dashboard')
  @RequirePermissions(PERMISSION.CAMPAIGN_ANALYTICS_READ)
  dashboard() {
    return this.analytics.dashboard(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Campaign statistics',
    description: `
**Protected — requires \`campaign_analytics.read\`. Clinic must be active.**

Campaign counts grouped by status with optional \`status\`/\`type\`/date filters.

**Who can call this:** Owner, Manager, Receptionist (\`campaign_analytics.read\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Campaign statistics.',
    schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', format: 'uuid' },
        totalCampaigns: { type: 'number' },
        byStatus: { type: 'object', additionalProperties: { type: 'number' } },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaign_analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('statistics')
  @RequirePermissions(PERMISSION.CAMPAIGN_ANALYTICS_READ)
  statistics(@Query() filter: CampaignAnalyticsFilterDto) {
    return this.analytics.statistics(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Campaign history',
    description: `
**Protected — requires \`campaign_analytics.read\`. Clinic must be active.**

Paginated list of campaigns (newest first) with a recipient count per
campaign, filterable by status/type/date range.

**Who can call this:** Owner, Manager, Receptionist (\`campaign_analytics.read\`).
    `.trim(),
  })
  @ApiOkResponse({ description: 'Campaign history (paginated).' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaign_analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('history')
  @RequirePermissions(PERMISSION.CAMPAIGN_ANALYTICS_READ)
  history(@Query() filter: CampaignAnalyticsFilterDto) {
    return this.analytics.history(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Campaign performance & delivery metrics',
    description: `
**Protected — requires \`campaign_analytics.read\`. Clinic must be active.**

Per-campaign performance: total recipients, delivered/failed/processed counts,
plus delivery rate and completion rate, and the full per-status breakdown.

**Who can call this:** Owner, Manager, Receptionist (\`campaign_analytics.read\`).

**Tenant scoping:** A campaign from another tenant returns 404.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign performance.', schema: S_PERFORMANCE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaign_analytics.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found in this tenant.', schema: S_ERROR })
  @Get('campaigns/:id/performance')
  @RequirePermissions(PERMISSION.CAMPAIGN_ANALYTICS_READ)
  performance(@Param('id', ParseUUIDPipe) id: string) {
    return this.analytics.campaignSummary(this.ctx.requireTenantId(), id);
  }
}
