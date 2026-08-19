import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentConfirmedEvent,
  AppointmentCreatedEvent,
  AppointmentInProgressEvent,
  AppointmentNoShowEvent,
  AppointmentRescheduledEvent,
} from '../../events/appointment.events';
import {
  PAYMENT_EVENT,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';
import {
  SUBSCRIPTION_EVENT,
  SubscriptionActivatedEvent,
  SubscriptionCancelledEvent,
  SubscriptionPlanChangedEvent,
  SubscriptionReactivatedEvent,
  SubscriptionTrialStartedEvent,
} from '../../events/subscription.events';
import {
  HANDOVER_EVENT,
  HandoverAssignedEvent,
  HandoverCustomerRepliedEvent,
  HandoverRequestedEvent,
  HandoverTransferredEvent,
} from '../../events/handover.events';

import { NotificationRuleService } from './notification-rule.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { RECIPIENT_TYPE } from './notification.constants';

/**
 * Bridges domain events to the notification scheduling pipeline.
 *
 * Responsibilities (and ONLY these):
 *  1. Receive a typed domain event via @OnEvent().
 *  2. Query the tenant's active NotificationRules for the matching trigger_event.
 *  3. For each rule with a template, compute scheduled_at from rule.delay_minutes
 *     and enqueue a ScheduledNotification via NotificationSchedulerService.
 *
 * Never:
 *  - Send notifications synchronously.
 *  - Contain business logic from Appointment / Payment / Subscription domains.
 *  - Import or inject anything from those modules.
 *
 * Errors are caught and logged per-rule so one bad rule cannot suppress others.
 */
@Injectable()
export class NotificationEventListener {
  private readonly logger = new Logger(NotificationEventListener.name);

  constructor(
    private readonly rules: NotificationRuleService,
    private readonly scheduler: NotificationSchedulerService,
  ) {}

  // ─────────────────────────── Appointment events ─────────────────────────── //

  @OnEvent(APPOINTMENT_EVENT.CREATED)
  async onAppointmentCreated(event: AppointmentCreatedEvent): Promise<void> {
    await this.dispatch(event.tenantId, APPOINTMENT_EVENT.CREATED, {
      customerId: event.customerId,
      appointmentId: event.appointmentId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.CONFIRMED)
  async onAppointmentConfirmed(event: AppointmentConfirmedEvent): Promise<void> {
    await this.dispatch(event.tenantId, APPOINTMENT_EVENT.CONFIRMED, {
      customerId: event.customerId,
      appointmentId: event.appointmentId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.CANCELLED)
  async onAppointmentCancelled(event: AppointmentCancelledEvent): Promise<void> {
    await this.dispatch(event.tenantId, APPOINTMENT_EVENT.CANCELLED, {
      customerId: event.customerId,
      appointmentId: event.appointmentId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.COMPLETED)
  async onAppointmentCompleted(event: AppointmentCompletedEvent): Promise<void> {
    await this.dispatch(event.tenantId, APPOINTMENT_EVENT.COMPLETED, {
      customerId: event.customerId,
      appointmentId: event.appointmentId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.RESCHEDULED)
  async onAppointmentRescheduled(event: AppointmentRescheduledEvent): Promise<void> {
    await this.dispatch(event.tenantId, APPOINTMENT_EVENT.RESCHEDULED, {
      customerId: event.customerId,
      appointmentId: event.appointmentId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.NO_SHOW)
  async onAppointmentNoShow(event: AppointmentNoShowEvent): Promise<void> {
    await this.dispatch(event.tenantId, APPOINTMENT_EVENT.NO_SHOW, {
      customerId: event.customerId,
      appointmentId: event.appointmentId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.IN_PROGRESS)
  async onAppointmentInProgress(event: AppointmentInProgressEvent): Promise<void> {
    await this.dispatch(event.tenantId, APPOINTMENT_EVENT.IN_PROGRESS, {
      customerId: event.customerId,
      appointmentId: event.appointmentId,
    });
  }

  // ─────────────────────────── Payment events ─────────────────────────────── //

  @OnEvent(PAYMENT_EVENT.SUCCEEDED)
  async onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
    if (!event.customerId) return; // no customer to notify
    await this.dispatch(event.tenantId, PAYMENT_EVENT.SUCCEEDED, {
      customerId: event.customerId,
    });
  }

  @OnEvent(PAYMENT_EVENT.REFUNDED)
  async onPaymentRefunded(event: PaymentRefundedEvent): Promise<void> {
    if (!event.customerId) return;
    await this.dispatch(event.tenantId, PAYMENT_EVENT.REFUNDED, {
      customerId: event.customerId,
    });
  }

  @OnEvent(PAYMENT_EVENT.FAILED)
  async onPaymentFailed(event: PaymentFailedEvent): Promise<void> {
    if (!event.customerId) return;
    await this.dispatch(event.tenantId, PAYMENT_EVENT.FAILED, {
      customerId: event.customerId,
    });
  }

  // ─────────────────────────── Subscription events ─────────────────────────── //

  @OnEvent(SUBSCRIPTION_EVENT.ACTIVATED)
  async onSubscriptionActivated(event: SubscriptionActivatedEvent): Promise<void> {
    await this.dispatch(event.tenantId, SUBSCRIPTION_EVENT.ACTIVATED, {
      tenantId: event.tenantId,
    });
  }

  @OnEvent(SUBSCRIPTION_EVENT.TRIAL_STARTED)
  async onSubscriptionTrialStarted(event: SubscriptionTrialStartedEvent): Promise<void> {
    await this.dispatch(event.tenantId, SUBSCRIPTION_EVENT.TRIAL_STARTED, {
      tenantId: event.tenantId,
    });
  }

  @OnEvent(SUBSCRIPTION_EVENT.CANCELLED)
  async onSubscriptionCancelled(event: SubscriptionCancelledEvent): Promise<void> {
    await this.dispatch(event.tenantId, SUBSCRIPTION_EVENT.CANCELLED, {
      tenantId: event.tenantId,
    });
  }

  @OnEvent(SUBSCRIPTION_EVENT.PLAN_CHANGED)
  async onSubscriptionPlanChanged(event: SubscriptionPlanChangedEvent): Promise<void> {
    await this.dispatch(event.tenantId, SUBSCRIPTION_EVENT.PLAN_CHANGED, {
      tenantId: event.tenantId,
    });
  }

  @OnEvent(SUBSCRIPTION_EVENT.REACTIVATED)
  async onSubscriptionReactivated(event: SubscriptionReactivatedEvent): Promise<void> {
    await this.dispatch(event.tenantId, SUBSCRIPTION_EVENT.REACTIVATED, {
      tenantId: event.tenantId,
    });
  }

  // ────────────────────── Live Agent Handover events ──────────────────────── //
  // Same reuse pattern as every other domain above: a tenant only gets
  // notified once they've configured a NotificationRule whose trigger_event
  // matches one of these strings with a template — no rule/template means no
  // dispatch, by design (see `dispatch()` below). The realtime WS push (see
  // HandoverRealtimeListener in ai-realtime module) is the immediate,
  // always-on delivery an online agent actually sees; this is the durable,
  // configurable, multi-channel (WhatsApp/Email) notification path for
  // when they aren't.

  @OnEvent(HANDOVER_EVENT.REQUESTED)
  async onHandoverRequested(event: HandoverRequestedEvent): Promise<void> {
    await this.dispatch(event.tenantId, HANDOVER_EVENT.REQUESTED, { tenantId: event.tenantId });
  }

  @OnEvent(HANDOVER_EVENT.ASSIGNED)
  async onHandoverAssigned(event: HandoverAssignedEvent): Promise<void> {
    await this.dispatch(event.tenantId, HANDOVER_EVENT.ASSIGNED, { userId: event.assignedToUserId });
  }

  @OnEvent(HANDOVER_EVENT.TRANSFERRED)
  async onHandoverTransferred(event: HandoverTransferredEvent): Promise<void> {
    await this.dispatch(event.tenantId, HANDOVER_EVENT.TRANSFERRED, { userId: event.toUserId });
  }

  @OnEvent(HANDOVER_EVENT.CUSTOMER_REPLIED)
  async onHandoverCustomerReplied(event: HandoverCustomerRepliedEvent): Promise<void> {
    if (!event.assignedToUserId) return; // nobody to notify — still Waiting/unassigned
    await this.dispatch(event.tenantId, HANDOVER_EVENT.CUSTOMER_REPLIED, { userId: event.assignedToUserId });
  }

  // ─────────────────────────── Core dispatch ─────────────────────────────── //

  /**
   * Finds all active rules for the given trigger event and enqueues a
   * ScheduledNotification for each one.
   *
   * @param tenantId   - The clinic whose rules to evaluate.
   * @param trigger    - The event name string (e.g. 'appointment.created').
   * @param context    - Recipient / appointment context for the notification.
   */
  private async dispatch(
    tenantId: string,
    trigger: string,
    context: {
      customerId?: string;
      appointmentId?: string;
      tenantId?: string;
      userId?: string;
    },
  ): Promise<void> {
    let activeRules;
    try {
      activeRules = await this.rules.findActiveByTrigger(tenantId, trigger);
    } catch (err) {
      this.logger.error(
        `Failed to load notification rules for ${trigger}: ${(err as Error)?.message}`,
      );
      return;
    }

    for (const rule of activeRules) {
      if (!rule.template) continue; // rule has no template — cannot dispatch

      const scheduledAt = new Date(
        Date.now() + (rule.delay_minutes ?? 0) * 60_000,
      ).toISOString();

      const recipientType = context.userId
        ? RECIPIENT_TYPE.USER
        : context.customerId
          ? RECIPIENT_TYPE.CUSTOMER
          : RECIPIENT_TYPE.TENANT;
      const recipientId = context.userId ?? context.customerId ?? context.tenantId ?? tenantId;

      try {
        await this.scheduler.schedule(tenantId, {
          templateId: rule.template.id,
          appointmentId: context.appointmentId,
          recipientType,
          recipientId,
          scheduledAt,
        });
      } catch (err) {
        // Log but continue — a failure for one rule must not suppress others.
        this.logger.error(
          `Failed to schedule notification for rule ${rule.id} (trigger: ${trigger}): ${(err as Error)?.message}`,
        );
      }
    }
  }
}
