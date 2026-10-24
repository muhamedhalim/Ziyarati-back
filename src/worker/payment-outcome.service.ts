import { Injectable, Logger, Optional } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { DataSource } from 'typeorm';

import { Payment } from '../entities/Payments/Payment';
import { PaymentStatus } from '../entities/enums';
import { PaymentsOutcomeJob } from '../queue/job-data.interface';
import { AppointmentsService } from '../modules/appointment/appointment.service';
import { BillingUpgradeEntitlementListener } from '../modules/billing-upgrades/billing-upgrade-entitlement.listener';
import { ResourceEntitlementListener } from '../modules/resource-pricing/resource-entitlement.listener';
import {
  PAYMENT_PURPOSE,
  RECONCILIATION_KIND,
} from '../modules/payments/payments.constants';
import { PaymentLinkService } from '../modules/payments/payment-link.service';
import { PAYMENT_OUTCOME } from '../modules/payments/payment-outcome.outbox';
import { ReconciliationExceptionService } from '../modules/payments/reconciliation/reconciliation-exception.service';

export type PaymentOutcomeResult =
  | {
      applied: true;
      outcome: PaymentsOutcomeJob['outcome'];
      consumers: string[];
    }
  | { applied: false; reason: string };

/**
 * REL-005 — consumes `payments.outcome` jobs: applies the CONSEQUENCES of a
 * payment state change that the payment transaction itself wrote to the outbox.
 *
 * Why this exists, and why it is safe to run next to the in-process events:
 *
 *  - The events (`payment.succeeded` …) are emitted after the commit and are
 *    lost if the process dies in that gap. This job is written IN the commit, so
 *    it is not. It also reaches the consumers when the state change happened in
 *    the WORKER (the reconciliation sweep) — a process that does not load every
 *    listener the API does.
 *  - Every consumer called here is idempotent (a row lock plus a status
 *    re-check), so the fast path having already run makes this a cheap no-op.
 *  - The job acts on the payment's CURRENT state, never on a figure it carries,
 *    so a delayed or redelivered job converges instead of replaying stale data
 *    (e.g. a `paid` job that runs after a refund still applies, in order, what
 *    actually happened).
 *
 * Routing is by `payments.purpose`: BOOKING/MANUAL → the appointment,
 * ADDON → the resource purchase, BILLING_UPGRADE → the billing-upgrade request.
 * That avoids taking two pointless row locks per payment to find out which
 * flow owns it.
 *
 * Unlike the event handlers, this THROWS when a consumer fails so BullMQ
 * retries the job. A missing or foreign payment is the one non-retryable case:
 * it is logged and skipped, because retrying cannot change it.
 */
@Injectable()
export class PaymentOutcomeService {
  private readonly logger = new Logger('PaymentOutcomeService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly appointments: AppointmentsService,
    private readonly billingUpgrades: BillingUpgradeEntitlementListener,
    private readonly resources: ResourceEntitlementListener,
    private readonly paymentLinks: PaymentLinkService,
    // Optional: a duplicate-capture check is bookkeeping and must never fail the
    // outcome it rides on.
    @Optional()
    private readonly exceptions?: ReconciliationExceptionService,
  ) {}

  async process(job: PaymentsOutcomeJob): Promise<PaymentOutcomeResult> {
    const payment = await this.dataSource.getRepository(Payment).findOne({
      where: { id: job.paymentId },
      relations: { tenant: true, appointment: true },
    });

    // The tenant in the payload is a claim; the row is the truth.
    if (!payment || payment.tenant?.id !== job.tenantId) {
      this.logger.warn(
        `payments.outcome ${job.outcome}: payment ${job.paymentId} not found for tenant ${job.tenantId} — skipped`,
      );
      return { applied: false, reason: 'payment_not_found' };
    }

    const consumers: string[] = [];
    switch (job.outcome) {
      case PAYMENT_OUTCOME.PAID:
        await this.applyPaid(payment, consumers);
        break;
      case PAYMENT_OUTCOME.FAILED:
        await this.applyFailed(payment, consumers);
        break;
      case PAYMENT_OUTCOME.REFUNDED:
        await this.applyRefundedState(payment, consumers);
        break;
      case PAYMENT_OUTCOME.REFUND_RECORDED:
        await this.applyRefundRecorded(payment, job.refundId, consumers);
        break;
      default:
        throw new UnrecoverableError(
          `payments.outcome: unknown outcome "${String(job.outcome)}"`,
        );
    }
    return { applied: true, outcome: job.outcome, consumers };
  }

  /** A captured payment: confirm the booking / grant the add-on / apply the upgrade. */
  private async applyPaid(
    payment: Payment,
    consumers: string[],
  ): Promise<void> {
    // A payment can only be PAID, or have moved on from PAID. PENDING/FAILED
    // here means the row was not (or is no longer) captured — nothing to apply.
    if (
      payment.status !== PaymentStatus.PAID &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED &&
      payment.status !== PaymentStatus.REFUNDED
    ) {
      return;
    }

    switch (payment.purpose) {
      case PAYMENT_PURPOSE.ADDON:
        await this.resources.applyPaid(payment.id);
        consumers.push('resource-entitlement');
        return;
      case PAYMENT_PURPOSE.BILLING_UPGRADE:
        await this.billingUpgrades.applyPaid(payment.id);
        consumers.push('billing-upgrade-entitlement');
        return;
      default: {
        const appointmentId = payment.appointment?.id;
        if (!appointmentId) return;
        // Replay what actually happened, in order: it was paid (this confirms the
        // booking); if a refund already landed before this job ran, reflect that
        // too. Both calls are idempotent.
        const applied = await this.appointments.applyPaymentOutcome(
          payment.tenant.id,
          appointmentId,
          'paid',
        );
        if (applied === 'booking_closed') {
          // D-2: the booking was cancelled before this payment landed. It is NOT
          // confirmed and NOT marked paid; a person decides (refund policy is open).
          await this.flagPaidOnCancelledBooking(payment, appointmentId);
          consumers.push('reconciliation-exception');
          return;
        }
        await this.reflectRefundOnAppointment(payment, appointmentId);
        consumers.push('appointment');
        // The booking is paid, so its pay link is spent: a patient re-opening it
        // sees "already paid" instead of being offered a second charge. Idempotent
        // (only ACTIVE links move), so a redelivered job is a no-op.
        await this.paymentLinks.markUsedForAppointment(
          payment.tenant.id,
          appointmentId,
        );
        consumers.push('payment-link');
        // Two live captures for this booking means the payer was charged twice. Noticed
        // here, within seconds of the second one being applied, rather than at the next
        // daily report. Recorded for a human to refund; nothing is moved.
        await this.noticeDuplicateCapture(payment.id);
      }
    }
  }

  private async flagPaidOnCancelledBooking(
    payment: Payment,
    appointmentId: string,
  ): Promise<void> {
    this.logger.error(
      `ALERT: payment ${payment.id} was captured for CANCELLED booking ${appointmentId} — not confirmed; review in the reconciliation queue`,
    );
    if (!this.exceptions) return;
    await this.exceptions.raiseQuietly({
      kind: RECONCILIATION_KIND.STATUS_MISMATCH,
      provider: payment.gateway ?? 'unknown',
      objectId: payment.gateway_payment_id ?? payment.id,
      tenantId: payment.tenant.id,
      paymentId: payment.id,
      details: {
        reason: 'paid_on_cancelled_booking',
        appointmentId,
        amount: Number(payment.amount),
        currency: payment.currency,
        paymentStatus: payment.status,
      },
    });
  }

  private async noticeDuplicateCapture(paymentId: string): Promise<void> {
    if (!this.exceptions) return;
    try {
      await this.exceptions.checkDuplicateBookingCapture(paymentId);
    } catch (err) {
      this.logger.warn(
        `Duplicate-capture check failed for payment ${paymentId}: ${(err as Error).message}`,
      );
    }
  }

  /** A failed payment: only the flows that track a payment attempt have anything to do. */
  private async applyFailed(
    payment: Payment,
    consumers: string[],
  ): Promise<void> {
    // A late success may have overtaken the failure — never regress it.
    if (payment.status !== PaymentStatus.FAILED) return;

    switch (payment.purpose) {
      case PAYMENT_PURPOSE.ADDON:
        await this.resources.applyFailed(payment.id);
        consumers.push('resource-entitlement');
        return;
      case PAYMENT_PURPOSE.BILLING_UPGRADE:
        await this.billingUpgrades.applyFailed(payment.id);
        consumers.push('billing-upgrade-entitlement');
        return;
      default:
        // A failed booking payment has no consumer today: the appointment simply
        // stays PENDING_PAYMENT and the patient pays again.
        return;
    }
  }

  /** The payment's refunded state changed: reflect it on the booking. */
  private async applyRefundedState(
    payment: Payment,
    consumers: string[],
  ): Promise<void> {
    const appointmentId = payment.appointment?.id;
    if (!appointmentId) return;
    if (await this.reflectRefundOnAppointment(payment, appointmentId)) {
      consumers.push('appointment');
    }
  }

  /** A refund reached SUCCEEDED: revoke the add-on in proportion to the refunded total. */
  private async applyRefundRecorded(
    payment: Payment,
    refundId: string | undefined,
    consumers: string[],
  ): Promise<void> {
    if (!refundId) {
      throw new UnrecoverableError(
        'payments.outcome refund_recorded without a refundId',
      );
    }
    // Only add-ons carry an entitlement to reverse.
    if (payment.purpose !== PAYMENT_PURPOSE.ADDON) return;

    // The CUMULATIVE succeeded total as of NOW, not as of when the job was
    // written: the consumer revokes only the delta against what it already
    // revoked, so reading the latest figure makes redelivery and reordering safe.
    const rows = await this.dataSource.query(
      `SELECT COALESCE(SUM(amount), 0) AS sum FROM refunds
        WHERE "paymentId" = $1 AND status = 'SUCCEEDED'`,
      [payment.id],
    );
    const refundedMinor = Math.round(Number(rows?.[0]?.sum ?? 0) * 100);
    await this.resources.applyRefund(payment.id, refundId, refundedMinor);
    consumers.push('resource-entitlement');
  }

  private async reflectRefundOnAppointment(
    payment: Payment,
    appointmentId: string,
  ): Promise<boolean> {
    if (payment.status === PaymentStatus.REFUNDED) {
      await this.appointments.applyPaymentOutcome(
        payment.tenant.id,
        appointmentId,
        'refunded',
      );
      return true;
    }
    if (payment.status === PaymentStatus.PARTIALLY_REFUNDED) {
      await this.appointments.applyPaymentOutcome(
        payment.tenant.id,
        appointmentId,
        'partially_refunded',
      );
      return true;
    }
    return false;
  }
}
