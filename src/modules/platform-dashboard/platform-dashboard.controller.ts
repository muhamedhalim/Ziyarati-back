import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { PlatformDashboardService } from './platform-dashboard.service';
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
 * Read-only composition layer over the platform's existing analytics services.
 * It introduces no business logic of its own beyond the platform-wide lifecycle
 * counts (which no other service can express) and never mutates state.
 *
 * The guard is declared once, at the CONTROLLER, so every handler added later
 * inherits it — there is deliberately no per-route opt-out. Tenant scoping is
 * not applicable: cross-tenant reporting is the purpose, and the only thing
 * standing between a caller and every clinic's aggregate state is this role
 * check. No handler here accepts a tenant id, so there is no IDOR surface.
 *
 * Responses carry aggregates and `{id, name}` at most: never contact details,
 * never credentials or tokens, never raw audit values.
 */
@ApiTags('Platform Dashboard')
@ApiBearerAuth('JWT-auth')
@Controller('platform/dashboard')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformDashboardController {
  constructor(private readonly dashboard: PlatformDashboardService) {}

  @ApiOperation({
    summary: 'Point-in-time platform snapshot (super-admin)',
    description:
      'Clinic counts by approval lifecycle (each state separate — pending-verification is not pending-approval, and a suspension is not a rejection) and tenants grouped by canonical effective subscription state, including clinics with no subscription at all. ' +
      'Takes NO date range: every figure here is point-in-time, and an endpoint that cannot accept a range can never be accidentally filtered by one. All counts are exact platform-wide aggregates, never a sampled page.',
  })
  @ApiOkResponse({ description: 'Platform snapshot.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not `super_admin`.',
    schema: S_ERROR,
  })
  @Get('snapshot')
  snapshot() {
    return this.dashboard.snapshot();
  }
}
