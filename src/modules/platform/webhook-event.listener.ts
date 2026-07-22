import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentConfirmedEvent,
  AppointmentCreatedEvent,
  AppointmentNoShowEvent,
  AppointmentRescheduledEvent,
} from '../../events/appointment.events';
import {
  PAYMENT_EVENT,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';

import { WebhookDeliveryService } from './webhook-delivery.service';

/**
 * Bridges EXISTING domain events (appointment/payment — already consumed by
 * NotificationEventListener/WorkflowEventListener) to the outbound-webhook
 * delivery pipeline.
 *
 * Responsibilities (and ONLY these):
 *  1. Receive a typed domain event via @OnEvent().
 *  2. Build the safe, allowlisted payload (ids + scalars only — same policy
 *     as the domain event classes themselves; see appointment.events.ts).
 *  3. Hand off to WebhookDeliveryService.dispatchEvent, which fans out to
 *     every ACTIVE endpoint subscribed to this event type.
 *
 * Never sends anything synchronously — dispatchEvent only enqueues BullMQ
 * jobs, so a slow/unreachable tenant endpoint can never block the request
 * that triggered the domain event.
 */
@Injectable()
export class WebhookEventListener {
  constructor(private readonly delivery: WebhookDeliveryService) {}

  @OnEvent(APPOINTMENT_EVENT.CREATED)
  async onAppointmentCreated(event: AppointmentCreatedEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, APPOINTMENT_EVENT.CREATED, {
      appointmentId: event.appointmentId,
      customerId: event.customerId,
      staffId: event.staffId,
      branchId: event.branchId,
      startAt: event.startAt,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.CONFIRMED)
  async onAppointmentConfirmed(event: AppointmentConfirmedEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, APPOINTMENT_EVENT.CONFIRMED, {
      appointmentId: event.appointmentId,
      customerId: event.customerId,
      startAt: event.startAt,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.CANCELLED)
  async onAppointmentCancelled(event: AppointmentCancelledEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, APPOINTMENT_EVENT.CANCELLED, {
      appointmentId: event.appointmentId,
      customerId: event.customerId,
      reason: event.reason ?? null,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.COMPLETED)
  async onAppointmentCompleted(event: AppointmentCompletedEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, APPOINTMENT_EVENT.COMPLETED, {
      appointmentId: event.appointmentId,
      customerId: event.customerId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.RESCHEDULED)
  async onAppointmentRescheduled(event: AppointmentRescheduledEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, APPOINTMENT_EVENT.RESCHEDULED, {
      appointmentId: event.appointmentId,
      customerId: event.customerId,
      newStartAt: event.newStartAt,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.NO_SHOW)
  async onAppointmentNoShow(event: AppointmentNoShowEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, APPOINTMENT_EVENT.NO_SHOW, {
      appointmentId: event.appointmentId,
      customerId: event.customerId,
    });
  }

  @OnEvent(PAYMENT_EVENT.SUCCEEDED)
  async onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, PAYMENT_EVENT.SUCCEEDED, {
      paymentId: event.paymentId,
      amount: event.amount,
      currency: event.currency,
      customerId: event.customerId ?? null,
      appointmentId: event.appointmentId ?? null,
    });
  }

  @OnEvent(PAYMENT_EVENT.REFUNDED)
  async onPaymentRefunded(event: PaymentRefundedEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, PAYMENT_EVENT.REFUNDED, {
      paymentId: event.paymentId,
      amount: event.amount,
      currency: event.currency,
      customerId: event.customerId ?? null,
      isPartial: event.isPartial,
      appointmentId: event.appointmentId ?? null,
    });
  }

  @OnEvent(PAYMENT_EVENT.FAILED)
  async onPaymentFailed(event: PaymentFailedEvent): Promise<void> {
    await this.delivery.dispatchEvent(event.tenantId, PAYMENT_EVENT.FAILED, {
      paymentId: event.paymentId,
      customerId: event.customerId ?? null,
      appointmentId: event.appointmentId ?? null,
    });
  }
}
