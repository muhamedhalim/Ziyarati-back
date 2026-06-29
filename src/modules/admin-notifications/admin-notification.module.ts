import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminNotification } from '../../entities/SaaS-Core/AdminNotification';
import { AdminNotificationService } from './admin-notification.service';
import { AdminNotificationController } from './admin-notification.controller';

/**
 * Platform super-admin in-app notifications (e.g. verification submitted).
 * Exports the service so domain flows can enqueue notifications.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AdminNotification])],
  controllers: [AdminNotificationController],
  providers: [AdminNotificationService],
  exports: [AdminNotificationService],
})
export class AdminNotificationModule {}
