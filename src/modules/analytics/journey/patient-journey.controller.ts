import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../auth/decorators/require-any-permission.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';
import { PrivateCache } from '../../../common/http/private-cache.decorator';

import { ANALYTICS_MAX_AGE_SECONDS } from '../advanced-analytics.controller';
import { PatientJourneyService } from './patient-journey.service';
import { QueryPatientJourneyDto } from './dto/query-patient-journey.dto';
import { QueryPatientJourneyBreakdownDto } from './dto/query-patient-journey-breakdown.dto';

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

const AUTH_RESPONSES = {
  unauthorized: {
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  },
  forbidden: {
    description:
      'Caller lacks `analytics.dashboard.read`/`analytics.reports.read`, holds only the latter for a DIFFERENT branch, or the clinic is not active.',
    schema: S_ERROR,
  },
};

/**
 * Patient Journey plan (approved 2026-09-16). Booking → reminder → arrival
 * → wait → doctor call → consultation → completion, with deterministic
 * alerts and recommendations. Strictly ADDITIVE — the existing analytics
 * controllers are untouched. Shares the SAME `analytics.dashboard.read` /
 * `analytics.reports.read` gate and the SAME branch-scope resolution
 * (`AdvancedAnalyticsService.resolveScope`) as the rest of the analytics
 * module — never a second authorization model.
 */
@ApiTags('Analytics Journey')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.ANALYTICS)
@Controller('analytics/journey')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class PatientJourneyController {
  constructor(
    private readonly journey: PatientJourneyService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Patient journey summary',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Stage timeline, waiting/consultation KPIs, reminder coverage, duration suggestions and ranked insights for the requested range/scope.',
  })
  @ApiOkResponse({ description: 'Patient journey summary.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('summary')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  summary(
    @Query() dto: QueryPatientJourneyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.journey.summary(this.ctx.requireTenantId(), user, dto);
  }

  @ApiOperation({
    summary: 'Patient journey breakdown',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** The same figures as the summary, grouped by branch, practitioner, service, weekday or hour, paginated. Shares one cached aggregate with `GET .../summary` — switching dimension or page never re-runs the aggregation query.',
  })
  @ApiOkResponse({ description: 'Patient journey breakdown.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('breakdown')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  breakdown(
    @Query() dto: QueryPatientJourneyBreakdownDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.journey.breakdown(this.ctx.requireTenantId(), user, dto);
  }
}
