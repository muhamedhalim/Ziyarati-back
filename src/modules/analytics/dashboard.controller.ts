import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { DashboardMetricService } from './dashboard-metric.service';
import { QueryDashboardDto } from './dto/query-dashboard.dto';

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
 * Dashboard metrics (fast-read KPI snapshot). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext.
 *
 * Reads require `analytics.dashboard.read`. Refresh recomputes the snapshot — a
 * write — so it is guarded by `analytics.reports.manage` (the spec defines only
 * a dashboard READ permission; a heavy recomputation is gated behind a manage
 * permission rather than a read).
 */
@ApiTags('Analytics Dashboard')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.ANALYTICS)
@Controller('analytics/dashboard')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardMetricService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Get dashboard metrics',
    description:
      '**Protected — `analytics.dashboard.read`. Clinic active.** Fast key/value read of the precomputed KPI snapshot (no computation).',
  })
  @ApiOkResponse({ description: 'Dashboard metrics.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `analytics.dashboard.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.ANALYTICS_DASHBOARD_READ)
  get(@Query() query: QueryDashboardDto) {
    return this.dashboard.getMetrics(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Refresh dashboard metrics',
    description:
      '**Protected — `analytics.reports.manage`. Clinic active.** Recomputes the KPI snapshot from source and upserts the metric rows.',
  })
  @ApiOkResponse({ description: 'Refreshed dashboard metrics.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `analytics.reports.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.ANALYTICS_REPORTS_MANAGE)
  refresh() {
    return this.dashboard.refresh(this.ctx.requireTenantId());
  }
}
