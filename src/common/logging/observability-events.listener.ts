import { Injectable, Logger, Module } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  type AppointmentCancelledEvent,
  type AppointmentCreatedEvent,
  type AppointmentRescheduledEvent,
} from '../../events/appointment.events';
import {
  PAYMENT_EVENT,
  type PaymentFailedEvent,
  type PaymentRefundedEvent,
  type PaymentSucceededEvent,
} from '../../events/payment.events';
import {
  REFUND_EVENT,
  type RefundRecordedEvent,
} from '../../events/refund.events';
import { LOG_EVENT } from './log-events';

/**
 * Operational log lines for successful business transitions, taken from the
 * domain events the services ALREADY emit after each committed transition —
 * so the booking and payment code paths are not touched, and each transition
 * is logged exactly once, by whichever process (API or worker) performed it.
 *
 * These are diagnostic breadcrumbs, not the audit trail: durable records stay
 * in their tables (`audit_logs`, `activity_log`, `payments`). Fields are ids,
 * statuses and amounts only — never names, notes or the free-text cancellation
 * reason. Failures are logged by their owners (the exception filter, the job
 * wrapper), not here.
 *
 * Every handler swallows its own errors: a log line must never break an event
 * consumer chain that sends reminders or confirms bookings.
 */
@Injectable()
export class ObservabilityEventsListener {
  private readonly logger = new Logger('BusinessEvents');

  @OnEvent(APPOINTMENT_EVENT.CREATED)
  onAppointmentCreated(e: AppointmentCreatedEvent): void {
    this.safe(() =>
      this.logger.log({
        event: LOG_EVENT.APPOINTMENT_BOOKING_SUCCEEDED,
        message: 'Appointment booked',
        tenant_id: e.tenantId,
        appointment_id: e.appointmentId,
        branch_id: e.branchId,
        staff_id: e.staffId,
        starts_at: e.startAt,
      }),
    );
  }

  @OnEvent(APPOINTMENT_EVENT.CANCELLED)
  onAppointmentCancelled(e: AppointmentCancelledEvent): void {
    this.statusChanged(e.tenantId, e.appointmentId, 'cancelled');
  }

  @OnEvent(APPOINTMENT_EVENT.CONFIRMED)
  onAppointmentConfirmed(e: { tenantId: string; appointmentId: string }): void {
    this.statusChanged(e.tenantId, e.appointmentId, 'confirmed');
  }

  @OnEvent(APPOINTMENT_EVENT.COMPLETED)
  onAppointmentCompleted(e: { tenantId: string; appointmentId: string }): void {
    this.statusChanged(e.tenantId, e.appointmentId, 'completed');
  }

  @OnEvent(APPOINTMENT_EVENT.NO_SHOW)
  onAppointmentNoShow(e: { tenantId: string; appointmentId: string }): void {
    this.statusChanged(e.tenantId, e.appointmentId, 'no_show');
  }

  @OnEvent(APPOINTMENT_EVENT.RESCHEDULED)
  onAppointmentRescheduled(e: AppointmentRescheduledEvent): void {
    this.safe(() =>
      this.logger.log({
        event: LOG_EVENT.APPOINTMENT_RESCHEDULED,
        message: 'Appointment rescheduled',
        tenant_id: e.tenantId,
        appointment_id: e.appointmentId,
        starts_at: e.newStartAt,
        previous_starts_at: e.oldStartAt,
      }),
    );
  }

  @OnEvent(PAYMENT_EVENT.SUCCEEDED)
  onPaymentSucceeded(e: PaymentSucceededEvent): void {
    this.paymentState(e.tenantId, e.paymentId, 'succeeded', 'info', {
      amount: e.amount,
      currency: e.currency,
      appointment_id: e.appointmentId,
    });
  }

  @OnEvent(PAYMENT_EVENT.FAILED)
  onPaymentFailed(e: PaymentFailedEvent): void {
    this.paymentState(e.tenantId, e.paymentId, 'failed', 'warn', {
      appointment_id: e.appointmentId,
    });
  }

  @OnEvent(PAYMENT_EVENT.REFUNDED)
  onPaymentRefunded(e: PaymentRefundedEvent): void {
    this.paymentState(
      e.tenantId,
      e.paymentId,
      e.isPartial ? 'partially_refunded' : 'refunded',
      'info',
      {
        amount: e.amount,
        currency: e.currency,
      },
    );
  }

  @OnEvent(REFUND_EVENT.RECORDED)
  onRefundRecorded(e: RefundRecordedEvent): void {
    this.safe(() =>
      this.logger.log({
        event: LOG_EVENT.PAYMENT_REFUND_RECORDED,
        message: 'Refund recorded',
        tenant_id: e.tenantId,
        payment_id: e.paymentId,
        refund_id: e.refundId,
        refunded_cumulative_minor: e.refundedCumulativeMinor,
        payment_total_minor: e.paymentTotalMinor,
      }),
    );
  }

  private statusChanged(
    tenantId: string,
    appointmentId: string,
    status: string,
  ): void {
    this.safe(() =>
      this.logger.log({
        event: LOG_EVENT.APPOINTMENT_STATUS_CHANGED,
        message: `Appointment ${status}`,
        tenant_id: tenantId,
        appointment_id: appointmentId,
        status,
      }),
    );
  }

  private paymentState(
    tenantId: string,
    paymentId: string,
    state: string,
    level: 'info' | 'warn',
    extra: Record<string, unknown>,
  ): void {
    this.safe(() => {
      const record = {
        ...extra,
        event: LOG_EVENT.PAYMENT_STATE_CHANGED,
        message: `Payment ${state}`,
        tenant_id: tenantId,
        payment_id: paymentId,
        state,
      };
      if (level === 'warn') this.logger.warn(record);
      else this.logger.log(record);
    });
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // logging must never break a domain-event consumer chain
    }
  }
}

/** Imported by both process roots (AppModule, WorkerModule). */
@Module({ providers: [ObservabilityEventsListener] })
export class ObservabilityEventsModule {}
