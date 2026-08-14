import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { PlatformDashboardService } from './platform-dashboard.service';
import { DashboardAlertsService } from './dashboard-alerts.service';
import { QueryDashboardRangeDto } from './dto/query-dashboard-range.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    code: { type: 'string' },
    message: { type: 'string' },
  },
};

/**
 * Platform Control Center — super-admin only.
 *
 * Read-only composition over the platform's existing analytics services. It
 * introduces no business logic of its own beyond the platform-wide lifecycle
 * counts and growth series (which no other service expresses) and never mutates
 * state.
 *
 * The guard is declared once, at the CONTROLLER, so every handler added later
 * inherits it — there is deliberately no per-route opt-out. Tenant scoping is
 * not applicable: cross-tenant reporting is the purpose, and the only thing
 * between a caller and every clinic's aggregate state is this role check. No
 * handler here accepts a tenant id, so there is no IDOR surface.
 *
 * FOUR endpoints, not one and not fifteen. One would make a single slow
 * sub-query stall the whole page and remove any per-section failure or refresh
 * cadence; fifteen would put the console's front door over its request budget.
 * The split follows how the data actually behaves: point-in-time, period,
 * actionable, historical.
 *
 * Responses carry aggregates plus `{id, name}` at most — never contact details,
 * never credentials or tokens, never raw audit values.
 */
@ApiTags('Platform Dashboard')
@ApiBearerAuth('JWT-auth')
@Controller('platform/dashboard')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformDashboardController {
  constructor(
    private readonly dashboard: PlatformDashboardService,
    private readonly alertsService: DashboardAlertsService,
  ) {}

  @ApiOperation({
    summary: 'Point-in-time platform snapshot (super-admin)',
    description:
      'Clinic counts by approval lifecycle (each state separate — pending-verification is not pending-approval, and a suspension is not a rejection), tenants by canonical effective subscription state including those with no subscription at all, plan mix, upcoming renewals, clinics needing attention with their evidence, a condensed infrastructure strip, and quick-action badge counts. ' +
      'Takes NO date range: every figure here is point-in-time, and an endpoint that cannot accept a range can never be accidentally filtered by one. All counts are exact platform-wide aggregates, never a sampled page. Sources are settled independently — a Redis outage degrades the health strip and nothing else.',
  })
  @ApiOkResponse({ description: 'Platform snapshot.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not `super_admin`.', schema: S_ERROR })
  @Get('snapshot')
  snapshot(@Headers('cache-control') cacheControl?: string) {
    // The dashboard's Refresh button sends `Cache-Control: no-cache`; honouring
    // it is what makes "Updated 40s ago · Refresh" mean something rather than
    // re-serving the same cached payload the operator just asked to replace.
    const bypassCache = /no-cache/i.test(cacheControl ?? '');
    return this.dashboard.snapshot({ bypassCache });
  }

  @ApiOperation({
    summary: 'Period metrics with comparison + trends (super-admin)',
    description:
      'New clinics, marketplace platform revenue (`payments.platform_fee`), gross volume, failed payments, refunds and paying clinics for the selected window, each with the immediately preceding same-length window. ' +
      'A zero denominator is reported as `new` or `none`, never as a fabricated percentage. All boundaries are UTC and half-open. `currencies` names the currencies the money figures were summed over, so a mixed total is never stamped with one symbol.',
  })
  @ApiOkResponse({ description: 'Period summary.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not `super_admin`.', schema: S_ERROR })
  @Get('summary')
  summary(@Query() query: QueryDashboardRangeDto) {
    return this.dashboard.summary(query);
  }

  @ApiOperation({
    summary: 'Unified needs-attention feed (super-admin)',
    description:
      'Severity-ranked, deduplicated, bounded list of things that need an operator decision — pending approvals and verifications, expiring/past-due/grace-expired subscriptions, failed payments, broken or expiring WhatsApp connections, quota pressure, urgent tickets, failed jobs, stale workers, webhook failures, upgrade requests. ' +
      'Each entry is a CODE plus params (never backend-composed English) and carries a CTA route. Sources are settled independently; any that fail are named in `degradedSources` rather than silently shortening the list.',
  })
  @ApiOkResponse({ description: 'Alert feed.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not `super_admin`.', schema: S_ERROR })
  @Get('alerts')
  alerts() {
    return this.alertsService.alerts();
  }

  @ApiOperation({
    summary: 'Recent platform activity (super-admin)',
    description:
      'Clinic approval transitions and platform-admin configuration changes in the window. An ALLOWLISTED projection: action, entity type, timestamp, actor display name and target label only. Audit `old_values`/`new_values` and `ip_address` are never returned.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiOkResponse({ description: 'Activity feed.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller is not `super_admin`.', schema: S_ERROR })
  @Get('activity')
  activity(@Query() query: QueryDashboardRangeDto) {
    return this.dashboard.activity(query, query.limit ?? 10);
  }
}
