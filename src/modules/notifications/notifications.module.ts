import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { InAppNotification } from '../../entities/Notifications/InAppNotification';
import { NotificationPreference } from '../../entities/Notifications/NotificationPreference';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { NotificationVariableResolver } from './notification-variable-resolver.service';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { User } from '../../entities/Auth&RBAC/User';
import { Customer } from '../../entities/CRM/Customer';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';

import { NotificationTemplateService } from './notification-template.service';
import { NotificationRuleService } from './notification-rule.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationLogService } from './notification-log.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationEventListener } from './notification-event.listener';
import { NotificationAuditService } from './notification-audit.service';
import { ReminderSchedulerService } from './reminder-scheduler.service';
import { ReminderListener } from './reminder.listener';
import { PatientActionLinkVariablesService } from './patient-action-link-variables.service';

// ── Internal (in-app, staff-facing) notifications ──────────────────────────
// A separate pipeline from everything above, sharing this module only because
// the two are the same domain to a reader. See `internal/notification-catalog.ts`.
import { NotificationRecipientResolver } from './internal/notification-recipient.resolver';
import { InternalNotificationService } from './internal/internal-notification.service';
import { InternalNotificationReadService } from './internal/internal-notification-read.service';
import { InternalNotificationPreferenceService } from './internal/internal-notification-preference.service';
import { InternalNotificationListener } from './internal/internal-notification.listener';
import { InternalNotificationController } from './internal/internal-notification.controller';

import { NotificationTemplateController } from './notification-template.controller';
import { NotificationRuleController } from './notification-rule.controller';
import { NotificationSchedulerController } from './notification-scheduler.controller';
import { NotificationLogController } from './notification-log.controller';

import { WhatsappModule } from '../whatsapp/whatsapp.module';
// Spec 014 (Clinic Platform Completion) — T032: issues a CANCEL link on
// appointment.confirmed for the notification template's `{cancelUrl}`.
import { PatientActionsModule } from '../patient-actions/patient-actions.module';

// ── Delivery channel abstraction (spec 014 — T012/T013) ────────────────────
// Designed but previously never wired up (research.md R3): the factory and
// providers existed, but NOTHING registered them behind NOTIFICATION_CHANNELS,
// so NotificationDispatchService bypassed the abstraction with a hardcoded
// WhatsApp-only branch. `NoopChannelProvider` is DELIBERATELY never
// registered here — see its own docblock and controller-entitlement-coverage
// spec's sibling warning: it reports every send as a fake success, which
// would shadow a real provider and record undelivered messages as sent.
import { NotificationChannelFactory } from './channels/notification-channel.factory';
import { NOTIFICATION_CHANNELS } from './channels/notification-channel.interface';
import { MetaWhatsAppCloudProvider } from './channels/meta-whatsapp-cloud.provider';
import { EmailChannelProvider } from './channels/email-channel.provider';
// EmailProviderFactory comes from the @Global EmailModule (already imported
// once, at AppModule root) — no re-import needed here.

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
      InAppNotification,
      NotificationPreference,
      Appointment,
      AuditLog,
      // Read-only here — the recipient resolver queries users (and the RBAC
      // join tables by name) to decide who receives an internal notification.
      User,
      Customer,
      TenantSetting,
      // READ-ONLY: the clinic's display name, a template variable source
      // (`NotificationVariableResolver`).
      Tenant,
    ]),
    forwardRef(() => WhatsappModule),
    PatientActionsModule,
  ],
  controllers: [
    NotificationTemplateController,
    NotificationRuleController,
    NotificationSchedulerController,
    NotificationLogController,
    InternalNotificationController,
  ],
  providers: [
    NotificationTemplateService,
    NotificationRuleService,
    NotificationSchedulerService,
    NotificationLogService,
    NotificationDispatchService,
    NotificationVariableResolver,
    NotificationDeliveryService,
    NotificationEventListener,
    NotificationAuditService,
    ReminderSchedulerService,
    ReminderListener,
    PatientActionLinkVariablesService,
    NotificationRecipientResolver,
    InternalNotificationService,
    InternalNotificationReadService,
    InternalNotificationPreferenceService,
    InternalNotificationListener,
    // ── Delivery channel abstraction (T012/T013) ────────────────────────
    MetaWhatsAppCloudProvider,
    EmailChannelProvider,
    NotificationChannelFactory,
    {
      provide: NOTIFICATION_CHANNELS,
      // Explicit order (WhatsApp preferred, email fallback — FR-G010), not
      // incidental to provider-registration order. `resolve()` still picks
      // by `supports(channel)`, so order only matters if that ever stops
      // being exclusive per channel.
      useFactory: (
        whatsapp: MetaWhatsAppCloudProvider,
        email: EmailChannelProvider,
      ) => [whatsapp, email],
      inject: [MetaWhatsAppCloudProvider, EmailChannelProvider],
    },
  ],
  exports: [
    NotificationTemplateService,
    NotificationRuleService,
    NotificationSchedulerService,
    NotificationLogService,
    NotificationDispatchService,
    NotificationDeliveryService,
    ReminderSchedulerService,
    // Exported so the worker can run the retention sweep, and so future
    // producers outside this module can emit without importing the catalog.
    InternalNotificationService,
    InternalNotificationReadService,
    NotificationChannelFactory,
  ],
})
export class NotificationsModule {}
