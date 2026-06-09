import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';

import { NotificationTemplateService } from './notification-template.service';
import { NotificationRuleService } from './notification-rule.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationLogService } from './notification-log.service';
import { NotificationDispatchService } from './notification-dispatch.service';

import { NotificationTemplateController } from './notification-template.controller';
import { NotificationRuleController } from './notification-rule.controller';
import { NotificationSchedulerController } from './notification-scheduler.controller';
import { NotificationLogController } from './notification-log.controller';

import { NotificationChannelFactory } from './channels/notification-channel.factory';
import { NoopChannelProvider } from './channels/noop-channel.provider';
import { NOTIFICATION_CHANNELS } from './channels/notification-channel.interface';

/**
 * Notifications Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * ActiveTenantGuard + TenantContextService (tenant scope), and the global
 * JwtAuthGuard.
 *
 * Delivery is decoupled behind a strategy/factory: concrete channel providers
 * (WhatsApp/SMS/Email/Push/In-App) register into the NOTIFICATION_CHANNELS
 * multi-provider array (empty for now); NotificationChannelFactory resolves one
 * per dispatch, falling back to NoopChannelProvider. The NotificationDispatch
 * service is the single send seam a future BullMQ worker will call.
 *
 * Exports the services so other domains can register templates/rules and enqueue
 * notifications (e.g. appointments emitting `appointment.completed`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationTemplate,
      NotificationRule,
      ScheduledNotification,
      NotificationLog,
      Appointment,
    ]),
  ],
  controllers: [
    NotificationTemplateController,
    NotificationRuleController,
    NotificationSchedulerController,
    NotificationLogController,
  ],
  providers: [
    NotificationTemplateService,
    NotificationRuleService,
    NotificationSchedulerService,
    NotificationLogService,
    NotificationDispatchService,
    NotificationChannelFactory,
    NoopChannelProvider,
    // No real delivery providers yet — the array is the registration point.
    { provide: NOTIFICATION_CHANNELS, useValue: [] },
  ],
  exports: [
    NotificationTemplateService,
    NotificationRuleService,
    NotificationSchedulerService,
    NotificationLogService,
    NotificationDispatchService,
  ],
})
export class NotificationsModule {}
