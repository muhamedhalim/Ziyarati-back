import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { InternalNotificationReadService } from './internal-notification-read.service';
import { InternalNotificationPreferenceService } from './internal-notification-preference.service';
import { InboxFilterDto } from './dto/inbox-filter.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

const S_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    key: { type: 'string', example: 'SUPPORT_TICKET_REPLIED' },
    category: { type: 'string', example: 'SUPPORT' },
    priority: { type: 'string', example: 'HIGH' },
    title: { type: 'string', example: 'New reply on ticket SUP-000123' },
    body: { type: 'string' },
    linkUrl: { type: 'string', nullable: true, example: '/app/support?ticket=…' },
    entityType: { type: 'string', nullable: true, example: 'SupportTicket' },
    entityId: { type: 'string', format: 'uuid', nullable: true },
    isRead: { type: 'boolean' },
    readAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const S_PAGE = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_ITEM },
    total: { type: 'number', example: 42 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
    unread: { type: 'number', example: 7 },
  },
};

const S_PREFERENCES = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      category: { type: 'string', example: 'APPOINTMENTS' },
      muted: { type: 'boolean' },
      mutable: { type: 'boolean', example: true },
      keys: { type: 'array', items: { type: 'string' } },
    },
  },
};

/**
 * The caller's OWN internal notification inbox.
 *
 * ── WHY THIS CONTROLLER CARRIES NO PERMISSION, FEATURE OR SUBSCRIPTION GUARD ──
 * Every other controller in this module is wrapped in `PermissionsGuard`,
 * `ActiveTenantGuard`, `@RequireFeature(NOTIFICATIONS)` and
 * `@RequireActiveSubscription()`. This one deliberately is not, and each
 * omission is load-bearing:
 *
 *  - No PERMISSION. A permission answers "may you act on this resource?"; here
 *    the resource IS the caller. Every notification in this table already
 *    passed a permission check at WRITE time, in
 *    `NotificationRecipientResolver` — a user only has a row because they were
 *    eligible for it. Gating the read again would mean a receptionist could be
 *    sent a notification and then not be allowed to read it.
 *  - No ACTIVE TENANT / ACTIVE SUBSCRIPTION / FEATURE FLAG. A clinic that has
 *    just been suspended, or whose subscription lapsed, is exactly the clinic
 *    that most needs to read `CLINIC_SUSPENDED` or
 *    `SUBSCRIPTION_ENTERED_GRACE`. Putting the inbox behind those gates would
 *    hide the explanation for the outage behind the outage itself.
 *
 * Authentication still applies: `JwtAuthGuard` is registered globally as an
 * `APP_GUARD`, so every route here requires a valid principal. The one
 * authorization rule this surface needs — "you see your own notifications and
 * nobody else's" — is enforced by passing `user.id` from the verified token and
 * never accepting a recipient from the request.
 *
 * Serves BOTH tenant staff and platform operators from one set of routes; the
 * scope is already carried by the principal.
 */
@ApiTags('Notification Inbox')
@ApiBearerAuth('JWT-auth')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@Controller('notifications/inbox')
export class InternalNotificationController {
  constructor(
    private readonly read: InternalNotificationReadService,
    private readonly preferences: InternalNotificationPreferenceService,
  ) {}

  @ApiOperation({
    summary: "List the caller's own notifications",
    description: `
**Authenticated only — no permission, feature flag or active-subscription requirement.**

Returns the notifications addressed to the calling user, newest first, rendered in one
language. Defaults to unread only; pass \`status=all\` for history.

\`title\`/\`body\` are rendered at read time from the notification catalog, so the same
stored row renders in Arabic or English depending on \`locale\` (falling back to the
caller's \`preferred_locale\`, then English).

There is no way to request another user's notifications: the recipient is always taken
from the access token.`,
  })
  @ApiOkResponse({ description: 'The caller\'s notifications.', schema: S_PAGE })
  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() filter: InboxFilterDto,
  ) {
    return this.read.list(userId, filter);
  }

  @ApiOperation({
    summary: "Unread count for the caller's bell badge",
    description:
      '**Authenticated only.** Cheap enough to poll — served by a partial index over unread rows.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { count: { type: 'number', example: 7 } },
    },
  })
  @Get('unread-count')
  async unreadCount(@CurrentUser('id') userId: string) {
    return { count: await this.read.unreadCount(userId) };
  }

  @ApiOperation({
    summary: "The caller's notification preferences",
    description:
      '**Authenticated only.** Every category with its current setting. `mutable: false` means every ' +
      'notification in that category is required (e.g. SECURITY) and the API will refuse to mute it.',
  })
  @ApiOkResponse({ schema: S_PREFERENCES })
  @Get('preferences')
  async listPreferences(@CurrentUser('id') userId: string) {
    return this.preferences.list(userId);
  }

  @ApiOperation({
    summary: "Update the caller's notification preferences",
    description:
      '**Authenticated only.** Categories omitted from the payload are left unchanged. Muting a ' +
      'category in which every notification is mandatory is rejected outright rather than stored ' +
      'and then ignored at delivery time.',
  })
  @ApiOkResponse({ schema: S_PREFERENCES })
  @ApiUnprocessableEntityResponse({
    description: 'The payload tried to mute a category that cannot be turned off.',
  })
  @Put('preferences')
  @HttpCode(HttpStatus.OK)
  async updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.preferences.update(userId, dto);
  }

  @ApiOperation({
    summary: 'Mark one notification read',
    description:
      '**Authenticated only.** Idempotent — marking an already-read notification succeeds and does ' +
      'not move its timestamp. An id that is not the caller\'s returns **404**, not 403: a 403 would ' +
      "confirm the id exists, which is itself a disclosure.",
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { success: { type: 'boolean', example: true } },
    },
  })
  @ApiNotFoundResponse({ description: 'No such notification for this user.' })
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.read.markRead(userId, id);
    return { success: true };
  }

  @ApiOperation({
    summary: "Mark all of the caller's notifications read",
    description:
      "**Authenticated only.** Affects only the calling user's rows — unlike the legacy " +
      '`POST /admin/notifications/read-all`, which marks every row for every administrator.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        updated: { type: 'number', example: 7 },
      },
    },
  })
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllRead(@CurrentUser('id') userId: string) {
    const { updated } = await this.read.markAllRead(userId);
    return { success: true, updated };
  }
}
