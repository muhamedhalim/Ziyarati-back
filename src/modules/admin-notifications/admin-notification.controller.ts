import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AdminNotificationService } from './admin-notification.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Super-admin in-app notifications: list, unread badge count, and read state.
 */
@ApiTags('Admin Notifications')
@Controller('admin/notifications')
@UseGuards(RolesGuard)
@ApiBearerAuth('JWT-auth')
@Roles(ROLE.SUPER_ADMIN)
export class AdminNotificationController {
  constructor(private readonly notifications: AdminNotificationService) {}

  @ApiOperation({ summary: 'List recent admin notifications (super-admin)' })
  @ApiOkResponse({ description: 'Most recent notifications, newest first.' })
  @Get()
  list(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.notifications.listRecent(
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    );
  }

  @ApiOperation({ summary: 'Unread admin notification count (super-admin)' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { count: { type: 'number' } } },
  })
  @Get('unread-count')
  async unreadCount() {
    return { count: await this.notifications.unreadCount() };
  }

  @ApiOperation({ summary: 'Mark a notification read (super-admin)' })
  @Post(':id/read')
  async markRead(@Param('id', ParseUUIDPipe) id: string) {
    await this.notifications.markRead(id);
    return { success: true };
  }

  @ApiOperation({ summary: 'Mark all notifications read (super-admin)' })
  @Post('read-all')
  async markAllRead() {
    await this.notifications.markAllRead();
    return { success: true };
  }
}
