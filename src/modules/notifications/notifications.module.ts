import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { NotificationTemplateService } from './notification-template.service';
import { NotificationRuleService } from './notification-rule.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationLogService } from './notification-log.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationEventListener } from './notification-event.listener';
import { NotificationAuditService } from './notification-audit.service';

import { NotificationTemplateController } from './notification-template.controller';
import { NotificationRuleController } from './notification-rule.controller';
import { NotificationSchedulerController } from './notification-scheduler.controller';
import { NotificationLogController } from './notification-log.controller';

import { WhatsappModule } from '../whatsapp/whatsapp.module';

/**
 * Notifications Domain.
 *
 *  - WhatsApp delivery is DELEGATED to the WhatsApp module's send path
 *    (WhatsappExecutionService → per-tenant account via resolver + APPROVED
 *    template + quota). No duplicate provider / number / webhook here.
 *  - Dispatch: atomic claim → per-tenant rate limit → at-most-once send guard →
 *    delegate → SENT(+provider_ref) / transient-retry / permanent-FAIL; exhausted
 *    transients → DLQ.
 *  - Delivery webhooks are ingested by the SINGLE WhatsApp webhook, which calls
 *    NotificationDeliveryService (forwardRef both ways).
 *  - Durability sweep + stale-PROCESSING reclaim + log retention run in the worker.
 *
 * `TenantRateLimiterService` comes from the @Global QueueModule.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationTemplate,
      NotificationRule,
      ScheduledNotification,
      NotificationLog,
      Appointment,
      AuditLog,
    ]),
    forwardRef(() => WhatsappModule),
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
    NotificationDeliveryService,
    NotificationEventListener,
    NotificationAuditService,
  ],
  exports: [
    NotificationTemplateService,
    NotificationRuleService,
    NotificationSchedulerService,
    NotificationLogService,
    NotificationDispatchService,
    NotificationDeliveryService,
  ],
})
export class NotificationsModule {}
