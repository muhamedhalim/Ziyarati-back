import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { NoEntitlementRequired } from '../subscription-billing/decorators/no-entitlement-required.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

import { ActivityLogService } from './activity-log.service';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';
import { QueryActivitySuggestionsDto } from './dto/query-activity-suggestions.dto';

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
 * Spec 014 (Clinic Platform Completion) — T193 (US14, contracts/
 * clinic-surfaces.md F14). `GET /activity` and `GET /activity/actions`.
 *
 * `@NoEntitlementRequired(FeatureKey.CORE_WORKSPACE)` rather than the usual
 * togglable-capability decorator — accountability belongs to the always-on shell
 * (`CORE_WORKSPACE.alwaysOn === true`, one of the three `alwaysOn` keys the
 * entitlement-coverage spec accepts as a rationale), so gating it behind a
 * togglable capability would be a gate that always opens. See
 * `controller-entitlement-coverage.spec.ts`'s own decision table, which
 * already documents this controller/decorator pairing.
 */
@ApiTags('Activity Log')
@ApiBearerAuth('JWT-auth')
@NoEntitlementRequired(FeatureKey.CORE_WORKSPACE)
@Controller('activity')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class ActivityLogController {
  constructor(
    private readonly activityLog: ActivityLogService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'The clinic activity log',
    description:
      '**Protected — `audit.read`.** Allow-listed actions only, newest first, paginated. ' +
      'Field names only in `changedFields` — never raw before/after values (FR-U008).',
  })
  @ApiOkResponse({ description: 'The activity page.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `audit.read`.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.AUDIT_READ)
  async list(@Query() query: QueryActivityLogDto) {
    const tenantId = this.ctx.requireTenantId();
    return this.activityLog.list(tenantId, query);
  }

  @ApiOperation({
    summary: 'The activity allow-list',
    description:
      '**Protected — `audit.read`.** For populating the filter control — the exact set of actions ' +
      'that can ever appear (FR-U007).',
  })
  @ApiOkResponse({ description: 'The allow-listed action strings.' })
  @Get('actions')
  @RequirePermissions(PERMISSION.AUDIT_READ)
  actions() {
    return this.activityLog.actions();
  }

  @ApiOperation({
    summary: 'Typeahead suggestions for the activity search box',
    description:
      '**Protected — `audit.read`.** Up to a handful of short suggestion strings ' +
      '(actor names/emails, action names, entity labels) drawn from THIS tenant’s ' +
      'own allow-listed activity, ranked exact → prefix → trigram similarity. ' +
      'A separate route rather than an option on `GET /activity` because a ' +
      'suggestion is one string: returning a page of full audit rows per ' +
      'keystroke just to harvest names from it would move orders of magnitude ' +
      'more data.\n\n' +
      'Isolation is identical to `GET /activity` — same guards, same permission, ' +
      'same tenant binding, same allow-list — so a suggestion can never reveal a ' +
      'name, an action, or the existence of a row the caller could not already ' +
      'read on the page itself.',
  })
  @ApiOkResponse({
    description: 'The suggestion list (bounded, may be empty).',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `audit.read`.',
    schema: S_ERROR,
  })
  @Get('suggestions')
  @RequirePermissions(PERMISSION.AUDIT_READ)
  async suggestions(@Query() query: QueryActivitySuggestionsDto) {
    const tenantId = this.ctx.requireTenantId();
    return this.activityLog.suggestions(tenantId, query);
  }
}
