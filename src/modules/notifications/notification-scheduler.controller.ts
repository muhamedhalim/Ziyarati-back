import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { NotificationSchedulerService } from './notification-scheduler.service';
import { ScheduleNotificationDto } from './dto/schedule-notification.dto';
import { UpdateScheduledNotificationDto } from './dto/update-scheduled-notification.dto';
import { RescheduleNotificationDto } from './dto/reschedule-notification.dto';
import { ScheduledNotificationFilterDto } from './dto/scheduled-notification-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
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

const S_SCHEDULED = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    scheduled_at: { type: 'string', format: 'date-time' },
    status: {
      type: 'string',
      enum: ['PENDING', 'SCHEDULED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'CANCELLED'],
      example: 'SCHEDULED',
    },
    recipient_type: { type: 'string', nullable: true, example: 'CUSTOMER' },
    recipient_id: { type: 'string', format: 'uuid', nullable: true },
    template: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, channel: { type: 'string' } } },
    appointment: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_SCHEDULED_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_SCHEDULED },
    total: { type: 'number', example: 240 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

const S_DISPATCH_RESULT = {
  type: 'object',
  properties: {
    notification: S_SCHEDULED,
    result: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        providerRef: { type: 'string', nullable: true, example: 'noop' },
        error: { type: 'string', nullable: true },
      },
    },
    log: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string' } } },
  },
};

/**
 * Scheduled / queued notifications. Guarded by PermissionsGuard +
 * ActiveTenantGuard. Tenant id from TenantContext; every row belongs to the
 * caller's tenant. Creating a row (status SCHEDULED) is the enqueue seam a
 * future BullMQ producer plugs into.
 */
@ApiTags('Scheduled Notifications')
@ApiBearerAuth('JWT-auth')
@Controller('scheduled-notifications')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class NotificationSchedulerController {
  constructor(
    private readonly scheduler: NotificationSchedulerService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Schedule a notification',
    description: `
**Protected — requires \`notifications.manage\`. Clinic must be active.**

Queues a notification for delivery at \`scheduledAt\` (status \`SCHEDULED\`).
Optionally bound to a template, an appointment (for appointment-scoped
tracking), and a recipient. Template/appointment are validated against the
tenant (422 otherwise).

**Who can call this:** Owner, Manager (\`notifications.manage\`).

**Tenant scoping:** Stamped with the caller's tenant.
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Notification scheduled.', schema: S_SCHEDULED })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Template or appointment not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.NOTIFICATIONS_MANAGE)
  schedule(@Body() dto: ScheduleNotificationDto) {
    return this.scheduler.schedule(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List scheduled notifications',
    description: `
**Protected — requires \`notifications.read\`. Clinic must be active.**

Returns scheduled notifications with filters (\`status\`, \`templateId\`,
\`appointmentId\`, \`recipientType\`/\`recipientId\`, \`from\`/\`to\`) and pagination,
ordered by \`scheduled_at\`. Use \`status=SCHEDULED\`/\`PENDING\` for pending and
\`status=SENT\`/\`DELIVERED\` for completed.

**Who can call this:** Owner, Manager, Receptionist (\`notifications.read\`).
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated scheduled notifications.', schema: S_SCHEDULED_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.NOTIFICATIONS_READ)
  findAll(@Query() filter: ScheduledNotificationFilterDto) {
    return this.scheduler.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get a scheduled notification',
    description: `**Protected — requires \`notifications.read\`. Clinic must be active.** A row from another tenant returns 404.`,
  })
  @ApiParam({ name: 'id', description: 'Scheduled notification UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Scheduled notification.', schema: S_SCHEDULED })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Scheduled notification not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.NOTIFICATIONS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.scheduler.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a scheduled notification',
    description: `**Protected — requires \`notifications.manage\`. Clinic must be active.** Generic update (recipient, time, administrative status). Prefer cancel/reschedule/retry for lifecycle changes.`,
  })
  @ApiParam({ name: 'id', description: 'Scheduled notification UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Updated.', schema: S_SCHEDULED })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Not found.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Referenced template/appointment not found in this tenant.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.NOTIFICATIONS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScheduledNotificationDto,
  ) {
    return this.scheduler.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Cancel a scheduled notification',
    description: `
**Protected — requires \`notifications.manage\`. Clinic must be active.**

Sets status to \`CANCELLED\`. Allowed only from \`PENDING\`/\`SCHEDULED\`/\`FAILED\`
(409 from terminal states like SENT/DELIVERED).

**Who can call this:** Owner, Manager (\`notifications.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Scheduled notification UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Cancelled.', schema: S_SCHEDULED })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Cannot cancel from the current status.', schema: S_ERROR })
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.NOTIFICATIONS_MANAGE)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.scheduler.cancel(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Reschedule a notification',
    description: `
**Protected — requires \`notifications.manage\`. Clinic must be active.**

Moves the notification to a new \`scheduledAt\` and resets status to
\`SCHEDULED\`. Allowed from \`PENDING\`/\`SCHEDULED\`/\`FAILED\` (409 otherwise).

**Who can call this:** Owner, Manager (\`notifications.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Scheduled notification UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Rescheduled.', schema: S_SCHEDULED })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Cannot reschedule from the current status.', schema: S_ERROR })
  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.NOTIFICATIONS_MANAGE)
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleNotificationDto,
  ) {
    return this.scheduler.reschedule(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Retry a failed notification',
    description: `
**Protected — requires \`notifications.manage\`. Clinic must be active.**

Re-attempts delivery of a \`FAILED\` notification via the dispatcher (resolves
the channel provider, sends, and writes a fresh delivery log). 422 if the
notification is not in \`FAILED\` status.

In production this is also the operation a BullMQ retry/backoff policy would
invoke automatically.

**Who can call this:** Owner, Manager (\`notifications.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Scheduled notification UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Retry attempted; returns dispatch result + log.', schema: S_DISPATCH_RESULT })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notifications.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Not found.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Notification is not in FAILED status.', schema: S_ERROR })
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.NOTIFICATIONS_MANAGE)
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.scheduler.retry(this.ctx.requireTenantId(), id);
  }
}
