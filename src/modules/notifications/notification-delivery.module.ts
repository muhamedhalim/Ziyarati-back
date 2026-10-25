import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NotificationDeliveryService } from './notification-delivery.service';

/**
 * The delivery-status axis of `scheduled_notifications`, on its own.
 *
 * `NotificationDeliveryService` needs only the `ScheduledNotification`
 * repository, but it sat inside `NotificationsModule` — which imports
 * `WhatsappModule` to SEND — while the WhatsApp webhook has to call it to
 * RECORD delivery. That made Notifications ↔ WhatsApp a two-way module cycle
 * held together by `forwardRef`s. Hosting the service in this leaf module lets
 * both depend on it in one direction: Notifications → WhatsApp → this.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ScheduledNotification])],
  providers: [NotificationDeliveryService],
  exports: [NotificationDeliveryService],
})
export class NotificationDeliveryModule {}
