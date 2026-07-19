import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  PAYMENT_EVENT,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';
import { AppointmentsService } from './appointment.service';

/**
 * Booking ⇄ payment bridge.
 *
 * The payment domain emits these events ONLY after a verified, deduplicated,
 * committed state change (webhook / gateway verify / reconciliation) — so this
 * listener may trust them and confirm the booking. This is the ONLY path that
 * confirms a booking off a payment: browser redirects never do.
 *
 * Failures are logged, not rethrown: a booking-side hiccup must not fail the
 * payment webhook response (the payment reconciliation sweep + idempotent
 * `applyPaymentOutcome` make the bridge self-healing on the next event).
 */
@Injectable()
export class AppointmentPaymentListener {
  private readonly logger = new Logger('AppointmentPaymentListener');

  constructor(private readonly appointments: AppointmentsService) {}

  @OnEvent(PAYMENT_EVENT.SUCCEEDED)
  async onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
    if (!event.appointmentId) return;
    try {
      await this.appointments.applyPaymentOutcome(
        event.tenantId,
        event.appointmentId,
        'paid',
      );
    } catch (err) {
      this.logger.error(
        `Failed to confirm appointment ${event.appointmentId} for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent(PAYMENT_EVENT.REFUNDED)
  async onPaymentRefunded(event: PaymentRefundedEvent): Promise<void> {
    if (!event.appointmentId) return;
    try {
      await this.appointments.applyPaymentOutcome(
        event.tenantId,
        event.appointmentId,
        event.isPartial ? 'partially_refunded' : 'refunded',
      );
    } catch (err) {
      this.logger.error(
        `Failed to reflect refund on appointment ${event.appointmentId} for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
  }
}
