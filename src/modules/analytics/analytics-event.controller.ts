import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AnalyticsEventService } from './analytics-event.service';
import { TrackEventDto } from './dto/track-event.dto';
import { QueryEventsDto } from './dto/query-events.dto';

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
 * Analytics events (ingestion + audit trail). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id always from TenantContext.
 */
@ApiTags('Analytics Events')
@ApiBearerAuth('JWT-auth')
@Controller('analytics/events')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class AnalyticsEventController {
  constructor(
    private readonly events: AnalyticsEventService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Track an event',
    description: '**Protected — `analytics.events.manage`. Clinic active.** Records a raw analytics event for the caller tenant.',
  })
  @ApiCreatedResponse({ description: 'Event recorded.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.events.manage`, or clinic inactive.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.ANALYTICS_EVENTS_MANAGE)
  track(@Body() dto: TrackEventDto) {
    return this.events.track(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List / filter events',
    description: '**Protected — `analytics.events.read`. Clinic active.** Tenant-scoped, newest first, with type/entity/branch/date filters + pagination.',
  })
  @ApiOkResponse({ description: 'Paginated events.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.events.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.ANALYTICS_EVENTS_READ)
  list(@Query() query: QueryEventsDto) {
    return this.events.list(this.ctx.requireTenantId(), query);
  }
}
