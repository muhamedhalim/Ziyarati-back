import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { StaffPerformanceService } from './staff-performance.service';
import { QueryStaffPerformanceDto } from './dto/query-staff-performance.dto';

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
 * Fleet-wide staff performance. Guarded like the other report reads —
 * `analytics.reports.read` (no new permission introduced). Tenant id from
 * TenantContext.
 */
@ApiTags('Analytics Staff Performance')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.ANALYTICS)
@Controller('analytics/reports/staff')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class StaffPerformanceController {
  constructor(
    private readonly staffPerformance: StaffPerformanceService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List fleet-wide staff performance',
    description:
      '**Protected — `analytics.reports.read`. Clinic active.** Per-staff appointment counts (total/completed/cancelled/no-show), revenue, and average rating over a window (default: trailing 30 days). Only staff with at least one appointment in the window appear.',
  })
  @ApiOkResponse({ description: 'Staff performance rows.' })
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
  list(@Query() query: QueryStaffPerformanceDto) {
    return this.staffPerformance.list(this.ctx.requireTenantId(), query);
  }
}
