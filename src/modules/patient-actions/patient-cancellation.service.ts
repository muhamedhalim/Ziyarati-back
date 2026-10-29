import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AppError, ErrorCode } from '../../common/errors';
import { PatientActionLink } from '../../entities/Calendar&Appointments/PatientActionLink';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import {
  AppointmentActionOrigin,
  AppointmentStatus,
} from '../../entities/enums';

import { AppointmentsService } from '../appointment/appointment.service';
import {
  AppointmentAuditService,
  APPOINTMENT_AUDIT_ACTION,
} from '../appointment/appointment-audit.service';
import { PatientActionLinkService } from './patient-action-link.service';
import { PaymentLinkService } from '../payments/payment-link.service';
import {
  PatientChangeWindowService,
  DEFAULT_CHANGE_WINDOW_HOURS,
} from './patient-change-window.service';

/** Mirrors `AppointmentsService`'s own private `TERMINAL_STATUSES` — this is
 *  a DISPLAY-only check (what the GET response shows), never an enforcement
 *  path; the real write-path guard still lives solely in `cancel()` itself. */
const TERMINAL_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

export type CancelBlockedReason =
  | 'WINDOW_CLOSED'
  | 'TERMINAL_STATE'
  | 'DISABLED_BY_CLINIC'
  | 'PAST';

export interface CancelEligibility {
  allowed: boolean;
  blockedReason?: CancelBlockedReason;
}

/**
 * Spec 014 (Clinic Platform Completion) — T029/T030 (S1, FR-C007,
 * FR-C013, FR-C014). Enforces patient self-service cancellation
 * eligibility, then delegates the write to the UNCHANGED
 * `AppointmentsService.cancel` — this service never reimplements a
 * cancellation rule that already lives there (terminal-state guard,
 * transaction shape, emitted events).
 */
@Injectable()
export class PatientCancellationService {
  constructor(
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    private readonly appointments: AppointmentsService,
    private readonly links: PatientActionLinkService,
    private readonly paymentLinkService: PaymentLinkService,
    private readonly appointmentAudit: AppointmentAuditService,
    private readonly changeWindow: PatientChangeWindowService,
  ) {}

  /**
   * FR-C007 — the window in force AT REQUEST TIME applies, never the
   * window that was true when the link was issued. Delegates to
   * `PatientChangeWindowService`, the same rule FR-R009 applies to
   * rescheduling ("same basis as FR-C007").
   */
  async assertCancellationAllowed(
    tenantId: string,
    appointmentStartAt: Date,
  ): Promise<void> {
    await this.changeWindow.assertWithinWindow(tenantId, appointmentStartAt);
  }

  /**
   * Non-throwing eligibility summary for the GET (contracts/public-surfaces
   * §A `allowed.cancel` / `blockedReason`) — display only. The confirm route
   * (`cancelViaLink`) re-derives its own answer independently via
   * `assertCancellationAllowed` + the unchanged `AppointmentsService.cancel`,
   * so a stale read here can never let an actually-ineligible cancellation
   * through.
   */
  async describeCancelEligibility(
    tenantId: string,
    appointment: { status: AppointmentStatus; start_at: Date },
  ): Promise<CancelEligibility> {
    const settings = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
    });
    if (!settings?.self_cancellation_enabled) {
      return { allowed: false, blockedReason: 'DISABLED_BY_CLINIC' };
    }
    if (TERMINAL_STATUSES.includes(appointment.status)) {
      return { allowed: false, blockedReason: 'TERMINAL_STATE' };
    }
    if (appointment.start_at.getTime() <= Date.now()) {
      return { allowed: false, blockedReason: 'PAST' };
    }
    const hours = settings.cancellation_hours ?? DEFAULT_CHANGE_WINDOW_HOURS;
    const cutoffMs = appointment.start_at.getTime() - hours * 3600_000;
    if (Date.now() > cutoffMs) {
      return { allowed: false, blockedReason: 'WINDOW_CLOSED' };
    }
    return { allowed: true };
  }

  /**
   * The full patient-initiated cancellation: window check, delegate to the
   * unchanged `AppointmentsService.cancel` (no staff actor — `userId:
   * null`, `origin: PATIENT`), close any outstanding payment request,
   * consume the link. No refund is ever initiated automatically — a paid
   * appointment simply keeps its PAID status (no `refundAmount` is ever
   * passed here), which is exactly what surfaces the cancellation to the
   * clinic as a pending refund decision through the existing notification
   * and dashboard paths — no separate "flag" mechanism is needed.
   */
  async cancelViaLink(
    tenantId: string,
    link: PatientActionLink,
    reason?: string,
  ): Promise<Appointment> {
    const appointment = link.appointment;
    // BUG-03 — the clinic's opt-in is enforced on the WRITE, not only in the
    // GET's display-only eligibility: a clinic that never enabled online
    // cancellation must not have its appointments cancelled by a direct POST
    // to a link the page itself shows as "not available".
    const settings = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
    });
    if (!settings?.self_cancellation_enabled) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'Online cancellation is not available for this clinic',
        publicContext: { blockedReason: 'DISABLED_BY_CLINIC' },
      });
    }
    await this.assertCancellationAllowed(tenantId, appointment.start_at);

    const cancelled = await this.appointments.cancel(
      tenantId,
      null,
      appointment.id,
      { reason },
      AppointmentActionOrigin.PATIENT,
    );

    await this.closeOutstandingPaymentLinks(tenantId, appointment.id);
    await this.links.consume(link.id);

    // FR-G005 — attributable in the one existing audit trail. Records the
    // appointment id and origin only — never the token, its digest, or
    // patient contact details.
    await this.appointmentAudit.record(
      APPOINTMENT_AUDIT_ACTION.CANCELLED_BY_PATIENT,
      tenantId,
      appointment.id,
      { origin: AppointmentActionOrigin.PATIENT },
      // Branch context so the Activity log can answer "where" for a patient-
      // driven action too. No actor: a signed link has no authenticated user.
      { branchId: cancelled.branch?.id ?? null },
    );

    return cancelled;
  }

  /**
   * FR-C013/FR-C014 — a patient action must never move money, but an
   * ACTIVE payment link left behind after cancellation would remain
   * payable. Disables every active link for the appointment through the
   * existing `PaymentLinkService` — never a second disable mechanism.
   */
  private async closeOutstandingPaymentLinks(
    tenantId: string,
    appointmentId: string,
  ): Promise<void> {
    const active = await this.paymentLinkService.findActiveForAppointment(
      tenantId,
      appointmentId,
    );
    for (const link of active) {
      await this.paymentLinkService.disable(tenantId, link.id);
    }
  }
}
