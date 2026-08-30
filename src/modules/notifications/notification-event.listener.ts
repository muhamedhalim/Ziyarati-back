import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { PatientActionPurpose } from '../../entities/enums';
import { PatientActionLinkService } from '../patient-actions/patient-action-link.service';

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
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    private readonly patientActionLinks: PatientActionLinkService,
    private readonly config: ConfigService,
  ) {}

  /** Base URL for links embedded in outbound messages (APP_URL, else first
   *  FRONTEND_ORIGIN) — same pattern as `AuthService.appUrl`. */
  private appUrl(): string {
    return (
      this.config.get<string>('APP_URL') ??
      (this.config.get<string>('FRONTEND_ORIGIN') ?? 'http://localhost:3000')
        .split(',')[0]
        .trim()
    );
  }

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
    const [cancelVars, rescheduleVars] = await Promise.all([
      this.buildActionLinkVariables(
        event.tenantId,
        event.appointmentId,
        PatientActionPurpose.CANCEL,
        'cancelUrl',
      ),
      this.buildActionLinkVariables(
        event.tenantId,
        event.appointmentId,
        PatientActionPurpose.RESCHEDULE,
        'rescheduleUrl',
      ),
    ]);
    await this.dispatch(
      event.tenantId,
      APPOINTMENT_EVENT.CONFIRMED,
      { customerId: event.customerId, appointmentId: event.appointmentId },
      { ...cancelVars, ...rescheduleVars },
    );
  }

  /**
   * T032/T044 (S1/S2, FR-C002/FR-R014) — issues a patient-action link
   * (`CANCEL` or `RESCHEDULE`) and returns its URL as a template variable
   * so the confirmation notification can carry it (`{cancelUrl}` /
   * `{rescheduleUrl}` in the template body). Never blocks the confirmation
   * notification itself: a failure here is logged and swallowed, returning
   * no variable, so the notification still sends without a broken link
   * rather than not sending at all.
   */
  private async buildActionLinkVariables(
    tenantId: string,
    appointmentId: string,
    purpose: PatientActionPurpose,
    variableName: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const appointment = await this.appointments.findOne({
        where: { id: appointmentId, tenant: { id: tenantId } },
        select: { id: true, start_at: true },
      });
      if (!appointment) return undefined;
      const secret = await this.patientActionLinks.issue(tenantId, appointment, purpose);
      return { [variableName]: `${this.appUrl()}/appointment-action/${secret}` };
    } catch (err) {
      this.logger.error(
        `Failed to issue a ${purpose} link for appointment ${appointmentId}: ${(err as Error)?.message}`,
      );
      return undefined;
    }
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
    extraVariables?: Record<string, unknown>,
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

      let scheduledAtDate: Date;
      if (rule.anchor === 'BEFORE_APPOINTMENT_START') {
        const anchor = await this.resolveBeforeAppointmentAnchor(
          tenantId,
          context.appointmentId,
          rule.delay_minutes ?? 0,
        );
        if (!anchor) continue; // no appointment to anchor to, or already past
        scheduledAtDate = anchor;
      } else {
        // AFTER_EVENT — byte-identical to the pre-T016 behaviour.
        scheduledAtDate = new Date(Date.now() + (rule.delay_minutes ?? 0) * 60_000);
      }
      const scheduledAt = scheduledAtDate.toISOString();

      const recipientType = context.userId
        ? RECIPIENT_TYPE.USER
        : context.customerId
          ? RECIPIENT_TYPE.CUSTOMER
          : RECIPIENT_TYPE.TENANT;
      const recipientId = context.userId ?? context.customerId ?? context.tenantId ?? tenantId;

      try {
        await this.scheduler.schedule(
          tenantId,
          {
            templateId: rule.template.id,
            appointmentId: context.appointmentId,
            recipientType,
            recipientId,
            scheduledAt,
          },
          undefined,
          extraVariables,
        );
      } catch (err) {
        // Log but continue — a failure for one rule must not suppress others.
        this.logger.error(
          `Failed to schedule notification for rule ${rule.id} (trigger: ${trigger}): ${(err as Error)?.message}`,
        );
      }
    }
  }

  /**
   * T017 (S3) — `scheduled_at` for a `BEFORE_APPOINTMENT_START` rule:
   * `appointment.start_at − leadMinutes`. `start_at` is a `timestamptz` — an
   * absolute instant — so subtracting a fixed duration from it is already
   * timezone-correct; there is nothing to convert. What matters is using
   * the appointment's OWN `start_at` (captured at booking time) rather than
   * reconstructing a time from the branch's CURRENT timezone setting, which
   * could have changed since booking or disagree across a DST transition.
   *
   * Returns `null` (skip scheduling — never a late send) when there is no
   * appointment to anchor to, or the computed moment is already past.
   */
  private async resolveBeforeAppointmentAnchor(
    tenantId: string,
    appointmentId: string | undefined,
    leadMinutes: number,
  ): Promise<Date | null> {
    if (!appointmentId) return null;
    const appointment = await this.appointments.findOne({
      where: { id: appointmentId, tenant: { id: tenantId } },
      select: { id: true, start_at: true },
    });
    if (!appointment) return null;

    const anchor = new Date(appointment.start_at.getTime() - leadMinutes * 60_000);
    return anchor.getTime() > Date.now() ? anchor : null;
  }
}
