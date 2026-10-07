import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Payment } from '../../entities/Payments/Payment';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  PaymentStatus,
} from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { OnlinePaymentCapabilityService } from './online-payment-capability.service';
import { PaymentLinkService, PublicPayLinkRef } from './payment-link.service';
import { PaymentService } from './payment.service';
import { PaymentsConfig } from './payments.config';
import {
  CLINIC_REVENUE_PURPOSES,
  PAYMENT_LINK_STATUS,
  PAYMENT_PURPOSE,
  round2,
} from './payments.constants';

/**
 * How long a hosted charge can still be payable: Tap's own maximum is 60 minutes
 * (default 30), plus a margin for clock skew and a payer who is mid-3DS. An
 * attempt older than this that the gateway still calls open is dead for every
 * practical purpose and is replaced instead of re-offered.
 */
const ATTEMPT_MAX_AGE_MINUTES = 75;

/** Appointment states a patient can still pay for. */
const PAYABLE_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING_PAYMENT,
  AppointmentStatus.CONFIRMED,
];

/** A Tap charge id, as it comes back on the redirect (`?tap_id=chg_…`). */
const CHARGE_ID_SHAPE = /^chg_[A-Za-z0-9_-]{6,80}$/;

const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * What a patient can do with a pay link, as the public pages see it.
 *  - payable     the clinic can take this payment and the booking is open
 *  - paid        money already moved (or the link was spent)
 *  - expired     link expired / disabled, or the booking is closed or settled otherwise
 *  - unavailable the clinic cannot take an online payment right now
 */
export type PublicPayState = 'payable' | 'paid' | 'expired' | 'unavailable';

export interface PublicPayView {
  state: PublicPayState;
  clinicName: string;
  serviceNames: string[];
  startAt: string;
  timezone?: string;
  amount: number;
  currency: string;
}

export type PublicCheckoutResult =
  | { state: 'redirect'; redirectUrl: string }
  | { state: 'paid' | 'expired' | 'unavailable' }
  /** An attempt is in flight (or the gateway cannot say yet): retry shortly. */
  | { state: 'processing' }
  /** The gateway refused to start the payment. */
  | { state: 'failed' };

export interface PublicReturnResult {
  state: 'paid' | 'pending' | 'failed';
  amount: number;
  currency: string;
  /** Receipt facts, only once the payment is confirmed. */
  clinicName?: string;
  startAt?: string;
  timezone?: string;
}

/**
 * The patient-facing payment surface (Tap migration, Phase 4). A patient has no
 * account and no tenant context: the link TOKEN is the whole credential — the
 * same posture as the appointment-action and waitlist-offer links.
 *
 * What makes this safe to expose without a login:
 *  - NOTHING the client sends decides money. No amount, currency, tenant,
 *    merchant or gateway is accepted; the price is read from the appointment,
 *    the clinic from the link, the merchant from the clinic's approved Tap
 *    account — the same server-authoritative rule `PaymentService.create` applies.
 *  - Every refusal for a bad token is the same 404, so a token's existence is
 *    never disclosed; `resolve` returns only what a payer needs to recognise the
 *    booking (clinic, services, time, amount) — no patient identity.
 *  - The return endpoint takes a gateway charge id, looks it up among OUR
 *    booking payments, and reports what the gateway says. It cannot settle
 *    anything the gateway did not capture (`PaymentService.confirm` re-verifies
 *    amount and currency before booking PAID), and the webhook stays the
 *    authority — this is the "my page is stuck" backstop.
 *
 * A link is durable but a hosted charge is not (it expires within the hour), so
 * the link never stores a gateway URL: each open of `checkout` resumes a live
 * attempt or replaces a dead one.
 */
@Injectable()
export class PublicPaymentService {
  private readonly logger = new Logger('PublicPaymentService');

  constructor(
    private readonly links: PaymentLinkService,
    private readonly payments: PaymentService,
    private readonly capability: OnlinePaymentCapabilityService,
    private readonly dataSource: DataSource,
    private readonly config: PaymentsConfig,
  ) {}

  async resolve(token: string): Promise<PublicPayView> {
    const { appointment, state } = await this.describe(token);
    return {
      state,
      clinicName: appointment.tenant.name,
      serviceNames: (appointment.services ?? [])
        .map((s) => s.service?.name)
        .filter((n): n is string => !!n),
      startAt: appointment.start_at.toISOString(),
      timezone: appointment.branch?.timezone ?? appointment.booked_timezone,
      amount: round2(Number(appointment.total_amount ?? 0)),
      currency: appointment.currency,
    };
  }

  async checkout(token: string): Promise<PublicCheckoutResult> {
    const { ref, appointment, state } = await this.describe(token);
    if (state !== 'payable') return { state };

    const tenantId = ref.tenantId;
    const existing = await this.dataSource.getRepository(Payment).findOne({
      where: {
        tenant: { id: tenantId },
        appointment: { id: appointment.id },
        status: PaymentStatus.PENDING,
      },
      order: { created_at: 'DESC' },
    });

    if (existing) {
      const resumed = await this.resumeOrSupersede(tenantId, existing);
      if (resumed) return resumed;
    }

    try {
      const created = await this.payments.create(
        tenantId,
        { appointmentId: appointment.id },
        { purpose: PAYMENT_PURPOSE.BOOKING },
      );
      if (
        created.status === PaymentStatus.PAID ||
        created.status === PaymentStatus.PARTIALLY_REFUNDED
      ) {
        return { state: 'paid' };
      }
      if (isHttpsUrl(created.redirectUrl)) {
        return { state: 'redirect', redirectUrl: created.redirectUrl };
      }
      // A rejected create leaves a FAILED row; a lost race or an uncertain
      // create leaves a PENDING one with no URL to hand out yet.
      return created.status === PaymentStatus.FAILED
        ? { state: 'failed' }
        : { state: 'processing' };
    } catch (err) {
      if (err instanceof AppError) {
        // "already paid" (409) means another request won; anything else the
        // patient can act on is "ask the clinic" — never the server's wording.
        if (err.statusCode === 409) return { state: 'paid' };
        this.logger.warn(
          `Public checkout for appointment ${appointment.id} refused: ${err.message}`,
        );
        return { state: 'unavailable' };
      }
      throw err;
    }
  }

  /**
   * Where the payer lands after Tap's hosted page. `chargeId` is the only input.
   * Looks the charge up among booking payments only (a billing or add-on charge
   * is not this surface's business) and asks the gateway what happened; an
   * unknown id is the same 404 as a malformed one.
   */
  async confirmReturn(chargeId: string): Promise<PublicReturnResult> {
    if (typeof chargeId !== 'string' || !CHARGE_ID_SHAPE.test(chargeId)) {
      throw this.notFound();
    }
    const payment = await this.dataSource.getRepository(Payment).findOne({
      where: {
        gateway: 'tap',
        gateway_payment_id: chargeId,
        purpose: In([...CLINIC_REVENUE_PURPOSES]),
      },
      relations: { tenant: true, appointment: { branch: true } },
    });
    if (!payment?.tenant?.id) throw this.notFound();

    let settled: Payment = payment;
    if (payment.status === PaymentStatus.PENDING) {
      try {
        settled = await this.payments.confirm(
          payment.tenant.id,
          payment.id,
          {},
        );
      } catch (err) {
        // e.g. the gateway captured a different amount: leave it PENDING for an
        // operator (confirm already logged why) and tell the payer "pending".
        this.logger.warn(
          `Return confirmation for payment ${payment.id} not applied: ${(err as Error)?.message}`,
        );
      }
    }

    const state: PublicReturnResult['state'] =
      settled.status === PaymentStatus.PAID ||
      settled.status === PaymentStatus.PARTIALLY_REFUNDED ||
      settled.status === PaymentStatus.REFUNDED
        ? 'paid'
        : settled.status === PaymentStatus.FAILED
          ? 'failed'
          : 'pending';

    return {
      state,
      amount: round2(Number(settled.amount)),
      currency: settled.currency,
      ...(state === 'paid'
        ? {
            clinicName: payment.tenant.name,
            startAt: payment.appointment?.start_at?.toISOString(),
            timezone: payment.appointment?.branch?.timezone,
          }
        : {}),
    };
  }

  // ─────────────────────────────── internals ─────────────────────────────── //

  /**
   * An attempt for this booking is already PENDING. Returns the answer to give
   * the patient, or undefined when the attempt has been closed and a fresh one
   * should be created.
   */
  private async resumeOrSupersede(
    tenantId: string,
    attempt: Payment,
  ): Promise<PublicCheckoutResult | undefined> {
    if (!attempt.gateway_payment_id) {
      // It never reached the gateway (or we could not record that it did), so no
      // URL for it was ever shown to a payer and nobody can be mid-payment on it:
      // replacing it cannot strand or double-charge anyone.
      await this.payments.supersedePending(tenantId, attempt.id);
      return undefined;
    }

    // It has a gateway charge: ask the gateway first — the payer may have paid
    // and be waiting for a webhook.
    let current: Payment;
    try {
      current = await this.payments.confirm(tenantId, attempt.id, {});
    } catch (err) {
      this.logger.warn(
        `Could not verify payment ${attempt.id} while resuming checkout: ${(err as Error)?.message}`,
      );
      return { state: 'processing' };
    }

    if (
      current.status === PaymentStatus.PAID ||
      current.status === PaymentStatus.PARTIALLY_REFUNDED
    ) {
      return { state: 'paid' };
    }
    if (current.status !== PaymentStatus.PENDING) return undefined; // FAILED etc.

    const meta = current.metadata as
      | { redirect_url?: unknown; redirect_issued_at?: unknown }
      | undefined;
    const url = meta?.redirect_url;
    if (!isHttpsUrl(url)) return { state: 'processing' };

    // Age of the page we handed out, from the instant we recorded — NOT from
    // `created_at` (timestamp WITHOUT time zone: skewed by the server's UTC
    // offset when read back). A row with no instant is treated as live: the
    // worst case is the payer lands on an expired hosted page, and the next open
    // (after Tap reports the charge dead) replaces it.
    const issued = Date.parse(String(meta?.redirect_issued_at ?? ''));
    const ageMinutes = Number.isFinite(issued)
      ? (Date.now() - issued) / 60_000
      : 0;
    if (ageMinutes < ATTEMPT_MAX_AGE_MINUTES) {
      return { state: 'redirect', redirectUrl: url };
    }

    // Open at the gateway but past any possible payable window: dead. Replace it.
    const closed = await this.payments.supersedePending(tenantId, current.id);
    return closed ? undefined : { state: 'processing' };
  }

  /** Link + booking + capability → the state the patient sees. */
  private async describe(token: string): Promise<{
    ref: PublicPayLinkRef;
    appointment: Appointment;
    state: PublicPayState;
  }> {
    const ref = await this.links.findPublicByToken(token);
    if (!ref) throw this.notFound();

    const appointment = await this.dataSource
      .getRepository(Appointment)
      .findOne({
        where: { id: ref.appointmentId, tenant: { id: ref.tenantId } },
        relations: { tenant: true, branch: true, services: { service: true } },
      });
    if (!appointment) throw this.notFound();

    return { ref, appointment, state: await this.stateOf(ref, appointment) };
  }

  private async stateOf(
    ref: PublicPayLinkRef,
    appointment: Appointment,
  ): Promise<PublicPayState> {
    const settled =
      appointment.payment_status === AppointmentPaymentStatus.PAID ||
      appointment.payment_status ===
        AppointmentPaymentStatus.PARTIALLY_REFUNDED;
    if (settled || ref.status === PAYMENT_LINK_STATUS.USED) return 'paid';

    if (
      ref.status !== PAYMENT_LINK_STATUS.ACTIVE ||
      !PAYABLE_APPOINTMENT_STATUSES.includes(appointment.status) ||
      appointment.payment_status !== AppointmentPaymentStatus.UNPAID ||
      !(round2(Number(appointment.total_amount ?? 0)) > 0)
    ) {
      return 'expired';
    }

    // A deployment whose provider cannot complete a patient payment on this page
    // (a non-Tap provider in production) never offers one — however the clinic is set up.
    if (!this.config.patientPayPageServed) return 'unavailable';

    const cap = await this.capability.resolve(ref.tenantId);
    return cap.available ? 'payable' : 'unavailable';
  }

  /** The one refusal for a bad / unknown / foreign token or charge id. */
  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, { message: 'Not found' });
  }
}
