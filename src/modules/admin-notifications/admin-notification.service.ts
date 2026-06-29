import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AdminNotification } from '../../entities/SaaS-Core/AdminNotification';

export interface CreateAdminNotificationInput {
  type: string;
  title: string;
  body?: string;
  tenantId?: string;
  data?: Record<string, unknown>;
}

/**
 * In-app notifications for platform super-admins. Backs the admin unread badge
 * and notification list. Visible to all super-admins (not tenant-scoped).
 */
@Injectable()
export class AdminNotificationService {
  constructor(
    @InjectRepository(AdminNotification)
    private readonly notifications: Repository<AdminNotification>,
  ) {}

  create(input: CreateAdminNotificationInput): Promise<AdminNotification> {
    return this.notifications.save(
      this.notifications.create({
        type: input.type,
        title: input.title,
        body: input.body,
        tenant_id: input.tenantId,
        data: input.data,
        is_read: false,
      }),
    );
  }

  listRecent(limit = 50): Promise<AdminNotification[]> {
    return this.notifications.find({
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  unreadCount(): Promise<number> {
    return this.notifications.count({ where: { is_read: false } });
  }

  async markRead(id: string): Promise<void> {
    await this.notifications.update(
      { id },
      { is_read: true, read_at: new Date() },
    );
  }

  async markAllRead(): Promise<void> {
    await this.notifications.update(
      { is_read: false },
      { is_read: true, read_at: new Date() },
    );
  }
}
