import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { NotificationLogService } from './notification-log.service';
import { NotificationLogFilterDto } from './dto/notification-log-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

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

const S_LOG = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    template_id: { type: 'string', nullable: true },
    recipient_type: { type: 'string', nullable: true, example: 'CUSTOMER' },
    recipient_id: { type: 'string', format: 'uuid', nullable: true },
    channel: { type: 'string', nullable: true, example: 'WHATSAPP' },
    status: { type: 'string', nullable: true, example: 'SENT' },
    error_message: { type: 'string', nullable: true },
    sent_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_LOG_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_LOG },
    total: { type: 'number', example: 1420 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

const S_STATS = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    total: { type: 'number', example: 1420 },
    byStatus: { type: 'object', additionalProperties: { type: 'number' }, example: { SENT: 1300, FAILED: 120 } },
    byChannel: { type: 'object', additionalProperties: { type: 'number' }, example: { WHATSAPP: 1000, EMAIL: 420 } },
  },
};

/**
 * Notification delivery history & statistics. Guarded by PermissionsGuard +
 * ActiveTenantGuard. Tenant id from TenantContext; logs are isolated by their
 * `tenant` relation.
 */
@ApiTags('Notification Logs')
@ApiBearerAuth('JWT-auth')
@Controller('notification-logs')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class NotificationLogController {
  constructor(
    private readonly logs: NotificationLogService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List / filter notification logs',
    description: `
**Protected — requires \`notifications.read\`. Clinic must be active.**

Delivery history with filters: \`status\`, \`channel\`, \`templateId\` (notification
type), \`recipientType\`/\`recipientId\` (use CUSTOMER + id to filter by
customer), and \`from\`/\`to\` (created_at range), paginated newest-first.

**Edge case:** \`notification_logs\` has no appointment column — appointment-
scoped delivery tracking is on \`GET /scheduled-notifications?appointmentId=\`.

**Who can call this:** Owner, Manager, Receptionist (\`notifications.read\`).

**Tenant scoping:** Only the caller's logs are returned.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated logs.', schema: S_LOG_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.NOTIFICATIONS_READ)
  findAll(@Query() filter: NotificationLogFilterDto) {
    return this.logs.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Delivery statistics',
    description: `
**Protected — requires \`notifications.read\`. Clinic must be active.**

Aggregated delivery counts grouped by status and by channel for the tenant,
optionally bounded by a \`from\`/\`to\` date range. Powers delivery-health
dashboards (sent vs failed, channel mix).

**Who can call this:** Owner, Manager (\`notifications.read\`).
    `.trim(),
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO-8601 lower bound on created_at.' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO-8601 upper bound on created_at.' })
  @ApiOkResponse({ description: 'Delivery statistics.', schema: S_STATS })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.read`, or clinic inactive.', schema: S_ERROR })
  @Get('statistics')
  @RequirePermissions(PERMISSION.NOTIFICATIONS_READ)
  statistics(@Query('from') from?: string, @Query('to') to?: string) {
    return this.logs.statistics(this.ctx.requireTenantId(), from, to);
  }

  @ApiOperation({
    summary: 'Get log details',
    description: `**Protected — requires \`notifications.read\`. Clinic must be active.** A log from another tenant returns 404.`,
  })
  @ApiParam({ name: 'id', description: 'Log UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Log entry.', schema: S_LOG })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Log entry not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.NOTIFICATIONS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.logs.findOne(this.ctx.requireTenantId(), id);
  }
}
