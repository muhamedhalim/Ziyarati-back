import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AdvancedAnalyticsService } from './advanced-analytics.service';
import { METRIC_REGISTRY } from './metric-registry';
import { QueryAdvancedAnalyticsDto } from './dto/query-advanced-analytics.dto';
import { QueryAdvancedAnalyticsPageDto } from './dto/query-advanced-analytics-page.dto';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireAnyPermission } from '../auth/decorators/require-any-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { PrivateCache } from '../../common/http/private-cache.decorator';

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
 * How long the browser may reuse a payload from this controller without
 * re-asking.
 *
 * Originally sized for the two trend routes, matched to
 * `ANALYTICS_CACHE_TTL`'s 60 s default: a request sent inside this window
 * could only have been answered from the server-side cache anyway, so
 * skipping it costs no staleness the tenant was not already accepting.
 * Deliberately shorter than the TTL, not equal to it, so the browser copy can
 * never outlive the server copy it was derived from.
 *
 * Also applied to `rates`/`retention`/`performance/{services,branches,
 * channels}` (015-db-api-efficiency-audit CACHE-001/P3): those five have no
 * server-side cache at all, so the 60 s TTL argument above doesn't apply to
 * them — their safety rests instead on the frontend's own `AGGREGATE` tier
 * (`app/lib/api/cache-policy.ts`, 5 min `staleTime`, confirmed for exactly
 * these five call sites in `Ziyarati-font/app/features/clinic/advanced-
 * analytics.ts`): a 30 s browser cache is strictly shorter than staleness the
 * client already tolerates, so it adds none. Deliberately **not** applied to
 * the sixth, structurally-identical `performance/staff` handler — verified
 * during P3 that it has no frontend consumer at all, so there is no known
 * client tolerance to lean on for it.
 */
/** Exported so `PatientJourneyController` (Patient Journey plan, approved 2026-09-16) reuses the same browser-cache budget rather than a second constant. */
export const ANALYTICS_MAX_AGE_SECONDS = 30;

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
 * Spec 014 (Clinic Platform Completion) — T146 (US11, contracts/clinic-
 * surfaces.md §F11). Trends, rates, retention and performance over a chosen
 * range and branch — strictly ADDITIVE: the existing dashboard/daily/
 * monthly/staff routes are untouched (different controllers entirely).
 *
 * Every route (bar `metrics/definitions`) shares the SAME
 * `analytics.dashboard.read` / `analytics.reports.read` gate the rest of the
 * analytics module already uses; which of the two the caller holds decides
 * whether they see the whole clinic or are pinned to their own branch
 * (FR-A016 — enforced in `AdvancedAnalyticsService.resolveScope`, never at
 * the guard layer, since the guard only checks flat possession of either
 * slug).
 */
@ApiTags('Analytics Advanced')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.ANALYTICS)
@Controller('analytics')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class AdvancedAnalyticsController {
  constructor(
    private readonly advanced: AdvancedAnalyticsService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List metric definitions',
    description:
      '**Protected — clinic active.** The full metric registry (FR-A002): key, label, prose definition and source query for every figure any analytics route (existing or new) returns. Exposes no tenant data.',
  })
  @ApiOkResponse({ description: 'Metric definitions.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @Get('metrics/definitions')
  listDefinitions() {
    return { data: Object.values(METRIC_REGISTRY) };
  }

  @ApiOperation({
    summary: 'Analytics reporting currency',
    description:
      "**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** The single currency every revenue figure on the analytics page is summed in (`currency`), and the clinic's configured one (`configuredCurrency`). They differ when the clinic has never collected a payment in its configured currency. Amounts in other currencies are never added in.",
  })
  @ApiOkResponse({ description: 'Reporting currency.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('currency')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  reportingCurrency() {
    return this.advanced.reportingCurrency(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Appointment-volume trend',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Server-side, range- and branch-scoped daily appointment counts (FR-A004) — fixes R13 (the old UI mixed branches and read "last 14 rows" instead of "last 14 days"). `empty: true` when nothing at all matched the range/scope.',
  })
  @ApiOkResponse({ description: 'Appointment trend.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('trends/appointments')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  appointmentsTrend(
    @Query() dto: QueryAdvancedAnalyticsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.advanced.appointmentsTrend(
      this.ctx.requireTenantId(),
      user,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Revenue trend',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Server-side, range- and branch-scoped daily SETTLED (PAID) revenue (FR-A003), same definition as `sumBranchRevenue`. `empty: true` when nothing matched.',
  })
  @ApiOkResponse({ description: 'Revenue trend.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('trends/revenue')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  revenueTrend(
    @Query() dto: QueryAdvancedAnalyticsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.advanced.revenueTrend(this.ctx.requireTenantId(), user, dto);
  }

  @ApiOperation({
    summary: 'Cancellation / no-show / completion rates',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Cancellation rate (split patient vs clinic origin), no-show rate and completion rate over appointments SCHEDULED TO OCCUR in the period (FR-A005/FR-A006). `empty: true` when no appointment was scheduled to occur in range/scope.',
  })
  @ApiOkResponse({ description: 'Rates.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('rates')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  rates(
    @Query() dto: QueryAdvancedAnalyticsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.advanced.rates(this.ctx.requireTenantId(), user, dto);
  }

  @ApiOperation({
    summary: 'Patient retention + repeat-visit distribution',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Retention against the immediately-preceding, equal-length period, plus the repeat-visit distribution within the requested period (FR-A007/FR-A008). `empty: true` when the prior period has no completed activity to measure retention against.',
  })
  @ApiOkResponse({ description: 'Retention.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('retention')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  retention(
    @Query() dto: QueryAdvancedAnalyticsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.advanced.retention(this.ctx.requireTenantId(), user, dto);
  }

  @ApiOperation({
    summary: 'Service performance',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Per service: appointment count and booked line-item price, paginated (FR-A009/FR-A017).',
  })
  @ApiOkResponse({ description: 'Service performance.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('performance/services')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  performanceServices(
    @Query() dto: QueryAdvancedAnalyticsPageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.advanced.performanceServices(
      this.ctx.requireTenantId(),
      user,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Staff performance',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Per practitioner: appointments, SETTLED revenue, average rating and no-show rate, paginated (FR-A010/FR-A017).',
  })
  @ApiOkResponse({ description: 'Staff performance.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('performance/staff')
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  performanceStaff(
    @Query() dto: QueryAdvancedAnalyticsPageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.advanced.performanceStaff(
      this.ctx.requireTenantId(),
      user,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Branch performance',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Per branch: appointments and SETTLED revenue, paginated (FR-A011/FR-A017). A branch-restricted caller sees only their own branch — never a clinic-wide comparison (FR-A016).',
  })
  @ApiOkResponse({ description: 'Branch performance.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('performance/branches')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  performanceBranches(
    @Query() dto: QueryAdvancedAnalyticsPageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.advanced.performanceBranches(
      this.ctx.requireTenantId(),
      user,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Booking-channel performance',
    description:
      '**Protected — `analytics.dashboard.read` or `analytics.reports.read`. Clinic active.** Per `AppointmentSource`: appointments, completion rate and SETTLED revenue, paginated (FR-A012/FR-A017). Every channel is listed even at zero.',
  })
  @ApiOkResponse({ description: 'Channel performance.' })
  @ApiUnauthorizedResponse(AUTH_RESPONSES.unauthorized)
  @ApiForbiddenResponse(AUTH_RESPONSES.forbidden)
  @Get('performance/channels')
  @PrivateCache(ANALYTICS_MAX_AGE_SECONDS)
  @RequireAnyPermission(
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  )
  performanceChannels(
    @Query() dto: QueryAdvancedAnalyticsPageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.advanced.performanceChannels(
      this.ctx.requireTenantId(),
      user,
      dto,
    );
  }
}
