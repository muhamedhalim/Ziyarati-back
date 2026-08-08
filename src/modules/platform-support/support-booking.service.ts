import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';

import { SupportClinicResolver } from './support-clinic.resolver';
import { QuerySupportDiagnosticsDto } from './dto/query-support-diagnostics.dto';
import {
  isoOrNull,
  maskEmail,
  maskPersonName,
  maskPhone,
  sanitizeFailureReason,
} from './support-privacy.util';

/**
 * ============================================================================
 *  APPOINTMENT + PAYMENT DIAGNOSTICS
 * ============================================================================
 *
 * The two questions this exists to answer:
 *   "Why is the appointment still pending payment?"
 *   "Did the gateway ever tell us anything?"
 *
 * THIS IS NOT APPOINTMENT ACCESS. Platform Customer Service holds no
 * `appointments.*` or `crm.*` permission and cannot reach the appointment or
 * CRM APIs at all. What it gets here is a DIAGNOSTIC PROJECTION: the
 * scheduling/payment state machine and its timeline, with the patient reduced
 * to a masked identity sufficient to confirm "yes, that's the booking on the
 * ticket".
 *
 * NEVER QUERIED, let alone returned:
 *   - `appointment_notes` / `customer_notes` — clinical and staff notes
 *   - `customer_files`, `customer_profiles` — uploads, medical history,
 *     chronic conditions
 *   - `patients` — the medical record entity
 *   - `appointments.notes` — free-text booking notes, which in practice carry
 *     the reason for the visit
 *   - the `Customer` entity as a whole; only `full_name`/`phone`/`email` are
 *     read, and all three leave masked
 *
 * On the money side, deliberately excluded: card data and tokens (never
 * stored by this platform at all), gateway credentials, the raw signed webhook
 * payload, `Payment.metadata` (an unconstrained gateway snapshot), and the
 * platform's own economics — `platform_fee`, `gateway_fee`, `net_amount`,
 * `settlement_status`. Support diagnoses whether the patient's money moved,
 * not what the platform earned on it.
 *
 * There is NO write path anywhere in this file: Support cannot mark a payment
 * paid, refund, capture, void, change an amount or modify an appointment.
 */
@Injectable()
export class SupportBookingService {
  constructor(
    private readonly clinics: SupportClinicResolver,
    private readonly dataSource: DataSource,
  ) {}

  // ── Appointments ─────────────────────────────────────────────────────────

  async appointments(tenantId: string, query: QuerySupportDiagnosticsDto) {
    await this.clinics.assertExists(tenantId);

    const params = [tenantId, query.since()];
    const where = `a."tenantId" = $1 AND a.created_at >= $2`;

    const [[countRow], rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM appointments a WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        SELECT a.id, a.status, a.payment_status, a.source, a.created_at,
               a.start_at, a.end_at, a.booked_timezone, a.currency,
               b.name AS branch_name,
               c.full_name AS customer_name, c.phone AS customer_phone,
               (SELECT COUNT(*) FROM payment_links pl
                 WHERE pl."appointmentId" = a.id)::int AS payment_link_count,
               (SELECT COUNT(*) FROM payments p
                 WHERE p."appointmentId" = a.id AND p.status = 'PAID')::int AS succeeded_payments
          FROM appointments a
          LEFT JOIN branches b ON b.id = a."branchId"
          LEFT JOIN customers c ON c.id = a."customerId"
         WHERE ${where}
         ORDER BY a.created_at DESC
         LIMIT $3 OFFSET $4
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    return {
      data: rows.map((r: AppointmentRow) => this.toAppointmentSummary(r)),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
      windowDays: query.days,
    };
  }

  /**
   * One appointment, plus its status timeline and the services booked.
   *
   * The tenant filter is part of the lookup (not a post-hoc check), so an
   * appointment id belonging to a different clinic returns 404 rather than
   * leaking its existence — the same shape the tenant-side ticket lookups use.
   */
  async appointment(tenantId: string, appointmentId: string) {
    await this.clinics.assertExists(tenantId);

    const [row] = await this.dataSource.query(
      `
      SELECT a.id, a.status, a.payment_status, a.source, a.created_at,
             a.start_at, a.end_at, a.booked_timezone, a.currency,
             b.name AS branch_name,
             c.full_name AS customer_name, c.phone AS customer_phone,
             c.email AS customer_email,
             u.full_name AS booked_by_name,
             (SELECT COUNT(*) FROM payment_links pl
               WHERE pl."appointmentId" = a.id)::int AS payment_link_count,
             (SELECT COUNT(*) FROM payments p
               WHERE p."appointmentId" = a.id AND p.status = 'SUCCEEDED')::int AS succeeded_payments
        FROM appointments a
        LEFT JOIN branches b ON b.id = a."branchId"
        LEFT JOIN customers c ON c.id = a."customerId"
        LEFT JOIN users u ON u.id = a."bookedById"
       WHERE a.id = $2 AND a."tenantId" = $1
      `,
      [tenantId, appointmentId],
    );

    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Appointment not found' });
    }

    const [timeline, services, staff] = await Promise.all([
      this.dataSource.query(
        `SELECT status, triggered_by, created_at
           FROM appointment_status_logs
          WHERE "appointmentId" = $1
          ORDER BY created_at ASC`,
        [appointmentId],
      ),
      this.dataSource.query(
        `SELECT s.name
           FROM appointment_services aps
           JOIN services s ON s.id = aps."serviceId"
          WHERE aps."appointmentId" = $1`,
        [appointmentId],
      ),
      this.dataSource.query(
        `SELECT u.full_name
           FROM appointments a
           JOIN staff_profiles sp ON sp.id = a."staffId"
           JOIN users u ON u.id = sp.user_id
          WHERE a.id = $1`,
        [appointmentId],
      ),
    ]);

    return {
      ...this.toAppointmentSummary(row),
      // Clinic STAFF are named in full: they are the clinic's own employees
      // acting in a professional capacity, and a ticket about "Dr X's slots"
      // is unusable without the name. The PATIENT stays masked.
      staffName: staff[0]?.full_name ?? null,
      bookedByName: row.booked_by_name ?? null,
      serviceNames: services.map((s: { name: string }) => s.name),
      customerEmail: maskEmail(row.customer_email),
      statusTimeline: timeline.map((t: StatusLogRow) => ({
        status: t.status,
        triggeredBy: t.triggered_by ?? null,
        at: isoOrNull(t.created_at),
      })),
    };
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  /**
   * Payment attempts for the clinic, with the gateway-side facts a stuck
   * booking turns on: did a charge exist, did it succeed, did a webhook ever
   * arrive, and is there a live payment link the patient could still use.
   *
   * `webhook_received` is derived from `paid_at IS NOT NULL OR status <>
   * 'PENDING'` rather than invented: the payment row only ever leaves PENDING
   * when the platform processed a gateway callback, so a row still PENDING
   * with no `paid_at` IS the "no webhook arrived" diagnosis.
   */
  async payments(tenantId: string, query: QuerySupportDiagnosticsDto) {
    await this.clinics.assertExists(tenantId);

    const params = [tenantId, query.since()];
    const where = `p."tenantId" = $1 AND p.created_at >= $2`;

    const [[countRow], rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM payments p WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        SELECT p.id, p."appointmentId" AS appointment_id, p.status, p.gateway,
               p.amount, p.currency, p.payment_method, p.failure_reason,
               p.refund_status, p.created_at, p.paid_at, p.refunded_at,
               pl.status     AS link_status,
               pl.expires_at AS link_expires_at
          FROM payments p
          LEFT JOIN LATERAL (
            SELECT status, expires_at
              FROM payment_links
             WHERE "appointmentId" = p."appointmentId"
             ORDER BY created_at DESC
             LIMIT 1
          ) pl ON true
         WHERE ${where}
         ORDER BY p.created_at DESC
         LIMIT $3 OFFSET $4
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    return {
      data: rows.map((r: PaymentRow) => ({
        id: r.id,
        appointmentId: r.appointment_id ?? null,
        status: r.status,
        gateway: r.gateway ?? null,
        // The amount the PATIENT was charged — not the platform's cut. No
        // gateway_fee, platform_fee, net_amount or settlement_status appears.
        amount: r.amount == null ? null : Number(r.amount),
        currency: r.currency,
        /** e.g. `creditcard`, `applepay` — an instrument CLASS, never card data. */
        paymentMethod: r.payment_method ?? null,
        failureReason: sanitizeFailureReason(r.failure_reason),
        refundStatus: r.refund_status ?? null,
        createdAt: isoOrNull(r.created_at),
        succeededAt: isoOrNull(r.paid_at),
        refundedAt: isoOrNull(r.refunded_at),
        /**
         * Whether the gateway ever called back. A PENDING payment with no
         * `paid_at` means no callback was processed — the exact diagnosis for
         * "the appointment is stuck pending payment".
         */
        gatewayCallbackReceived: !!r.paid_at || r.status !== 'PENDING',
        paymentLink: r.link_status
          ? { status: r.link_status, expiresAt: isoOrNull(r.link_expires_at) }
          : null,
      })),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
      windowDays: query.days,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private toAppointmentSummary(r: AppointmentRow) {
    return {
      id: r.id,
      status: r.status,
      paymentStatus: r.payment_status,
      /** PLATFORM | WHATSAPP_BOT | PUBLIC_AI | MANUAL — where the booking came from. */
      source: r.source,
      createdAt: isoOrNull(r.created_at),
      scheduledStartAt: isoOrNull(r.start_at),
      scheduledEndAt: isoOrNull(r.end_at),
      bookedTimezone: r.booked_timezone ?? null,
      branchName: r.branch_name ?? null,
      currency: r.currency,
      /** Masked — enough to match the ticket, not enough to identify the person. */
      customerName: maskPersonName(r.customer_name),
      customerPhone: maskPhone(r.customer_phone),
      /**
       * INSURANCE means payment is settled outside this platform entirely, so
       * "unpaid" is the wrong reading. It is a payment CLASSIFICATION, never
       * insurance policy detail — no provider, policy number or coverage is
       * stored on the appointment or exposed here.
       */
      paymentExpected: r.payment_status !== 'INSURANCE',
      hasPaymentLink: (r.payment_link_count ?? 0) > 0,
      hasSucceededPayment: (r.succeeded_payments ?? 0) > 0,
    };
  }
}

interface AppointmentRow {
  id: string;
  status: string;
  payment_status: string;
  source: string;
  created_at: Date;
  start_at: Date;
  end_at: Date;
  booked_timezone: string | null;
  currency: string;
  branch_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email?: string | null;
  booked_by_name?: string | null;
  payment_link_count: number;
  succeeded_payments: number;
}

interface StatusLogRow {
  status: string;
  triggered_by: string | null;
  created_at: Date;
}

interface PaymentRow {
  id: string;
  appointment_id: string | null;
  status: string;
  gateway: string | null;
  amount: string | number | null;
  currency: string;
  payment_method: string | null;
  failure_reason: string | null;
  refund_status: string | null;
  created_at: Date;
  paid_at: Date | null;
  refunded_at: Date | null;
  link_status: string | null;
  link_expires_at: Date | null;
}
