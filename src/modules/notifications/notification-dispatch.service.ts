import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { AppError, ErrorCode } from '../../common/errors';

import { NotificationChannelFactory } from './channels/notification-channel.factory';
import { NotificationPayload } from './channels/notification-channel.interface';
import { NotificationLogService } from './notification-log.service';
import {
  NOTIFICATION_CHANNEL,
  NOTIFICATION_STATUS,
  TERMINAL_STATUSES,
  NotificationStatus,
} from './notification.constants';

/**
 * Performs the ACTUAL delivery of a scheduled notification and records the
 * outcome. This is the single seam a future queue worker (BullMQ consumer) will
 * call — `processScheduled` is idempotent-friendly and side-effect contained:
 *  1) mark PROCESSING, 2) resolve channel provider via the factory,
 *  3) send, 4) on success → SENT + log, on failure → FAILED + log(error).
 *
 * Tenant isolation: the scheduled row is loaded with `tenant: { id: tenantId }`,
 * and the log is recorded under the same tenant.
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger('NotificationDispatchService');

  constructor(
    @InjectRepository(ScheduledNotification)
    private readonly scheduled: Repository<ScheduledNotification>,
    private readonly channels: NotificationChannelFactory,
    private readonly logs: NotificationLogService,
  ) {}

  /** Delivers one scheduled notification and writes a log entry. */
  async processScheduled(tenantId: string, id: string) {
    const notification = await this.scheduled.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { template: true, appointment: true },
    });
    if (!notification) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Scheduled notification not found',
      });
    }
    if (TERMINAL_STATUSES.includes(notification.status as NotificationStatus)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Notification in status "${notification.status}" cannot be dispatched`,
      });
    }

    notification.status = NOTIFICATION_STATUS.PROCESSING;
    await this.scheduled.save(notification);

    const channel = notification.template?.channel ?? NOTIFICATION_CHANNEL.IN_APP;
    const payload: NotificationPayload = {
      tenantId,
      channel,
      recipientType: notification.recipient_type,
      recipientId: notification.recipient_id,
      templateId: notification.template?.id,
      appointmentId: notification.appointment?.id,
      contentAr: notification.template?.content_ar,
      contentEn: notification.template?.content_en,
    };

    const provider = this.channels.resolve(channel);
    let result;
    try {
      result = await provider.send(payload);
    } catch (err) {
      this.logger.error(`Provider "${provider.name}" threw during send`, err as Error);
      result = { success: false, error: (err as Error)?.message ?? 'provider error' };
    }

    notification.status = result.success
      ? NOTIFICATION_STATUS.SENT
      : NOTIFICATION_STATUS.FAILED;
    await this.scheduled.save(notification);

    const log = await this.logs.record(tenantId, {
      templateId: notification.template?.id,
      recipientType: notification.recipient_type,
      recipientId: notification.recipient_id,
      channel,
      status: notification.status,
      errorMessage: result.success ? undefined : result.error,
      sentAt: result.success ? new Date() : undefined,
    });

    return { notification, result, log };
  }

  /** Re-attempts a previously FAILED notification. */
  async retry(tenantId: string, id: string) {
    const notification = await this.scheduled.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!notification) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Scheduled notification not found',
      });
    }
    if (notification.status !== NOTIFICATION_STATUS.FAILED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Only failed notifications can be retried',
        context: { currentStatus: notification.status },
      });
    }
    return this.processScheduled(tenantId, id);
  }
}
