import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { PatientActionLink } from '../../entities/Calendar&Appointments/PatientActionLink';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentActionOrigin, AppointmentStatus } from '../../entities/enums';

import { AppointmentsService } from '../appointment/appointment.service';
import {
  AppointmentAuditService,
  APPOINTMENT_AUDIT_ACTION,
} from '../appointment/appointment-audit.service';
import {
  AvailabilityService,
  PublicAvailabilityWindow,
} from '../scheduling/availability.service';
import { PatientActionLinkService } from './patient-action-link.service';
import { PatientChangeWindowService } from './patient-change-window.service';
import type { CancelBlockedReason } from './patient-cancellation.service';

/** Mirrors `AppointmentsService`'s own private `TERMINAL_STATUSES` — see
 *  the identical note in `patient-cancellation.service.ts`. DISPLAY-only;
 *  the real write-path guard lives solely in `AppointmentsService.reschedule`. */
const TERMINAL_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

export type RescheduleBlockedReason = CancelBlockedReason;

export interface RescheduleEligibility {
  allowed: boolean;
  blockedReason?: RescheduleBlockedReason;
}

/**
 * Spec 014 (Clinic Platform Completion) — T041 (S2, FR-R001–R015).
 * Enforces patient self-service reschedule eligibility, then delegates the
 * move to the UNCHANGED `AppointmentsService.reschedule` — which already
 * re-validates through `AvailabilityService.assertBookable(...,
 * { excludeAppointmentId, manager })` inside its own transaction. This
 * service writes no scheduling logic of its own.
 */
@Injectable()
export class PatientRescheduleService {
  constructor(
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    private readonly appointments: AppointmentsService,
    private readonly availability: AvailabilityService,
    private readonly links: PatientActionLinkService,
    private readonly changeWindow: PatientChangeWindowService,
    private readonly appointmentAudit: AppointmentAuditService,
  ) {}

  /**
   * Non-throwing eligibility summary for the GET (contracts/public-surfaces
   * §A `allowed.reschedule`) — display only. `rescheduleViaLink` re-derives
   * its own answer independently, so a stale read here can never let an
   * actually-ineligible reschedule through.
   */
  async describeRescheduleEligibility(
    tenantId: string,
    appointment: { status: AppointmentStatus; start_at: Date },
  ): Promise<RescheduleEligibility> {
    const settings = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
    });
    if (!settings?.self_reschedule_enabled) {
      return { allowed: false, blockedReason: 'DISABLED_BY_CLINIC' };
    }
    if (TERMINAL_STATUSES.includes(appointment.status)) {
      return { allowed: false, blockedReason: 'TERMINAL_STATE' };
    }
    if (appointment.start_at.getTime() <= Date.now()) {
      return { allowed: false, blockedReason: 'PAST' };
    }
    const hours = await this.changeWindow.getWindowHours(tenantId);
    const cutoffMs = appointment.start_at.getTime() - hours * 3600_000;
    if (Date.now() > cutoffMs) {
      return { allowed: false, blockedReason: 'WINDOW_CLOSED' };
    }
    return { allowed: true };
  }

  /**
   * FR-R002/R003 — times come from the SAME `AvailabilityService` engine
   * that governs staff booking, for the appointment's EXISTING branch and
   * staff (FR-R004): the patient cannot change either through this route,
   * because they are never read from the request.
   */
  async getAvailability(
    tenantId: string,
    appointment: Appointment,
    fromDate: string,
    toDate: string,
  ): Promise<{ timezone: string; slots: PublicAvailabilityWindow[] }> {
    const { timezone, windows } = await this.availability.publicWindows(tenantId, {
      branchId: appointment.branch.id,
      staffId: appointment.staff.id,
      fromDate,
      toDate,
      slotMinutes: this.durationMinutes(appointment),
    });
    // contracts/public-surfaces.md §A names this field `slots`, distinct
    // from `AvailabilityService`'s own internal `windows` naming.
    return { timezone, slots: windows };
  }

  /**
   * The full patient-initiated reschedule: window check, delegate the move
   * to the unchanged `AppointmentsService.reschedule` (no staff actor —
   * `userId: null`, `origin: PATIENT`; branch/service/staff are read from
   * the existing appointment, never from the caller), consume the link.
   * Payment state is untouched — `reschedule()` never requests payment.
   */
  async rescheduleViaLink(
    tenantId: string,
    link: PatientActionLink,
    startAt: string,
  ): Promise<Appointment> {
    const appointment = link.appointment;
    await this.changeWindow.assertWithinWindow(tenantId, appointment.start_at);
    const previousStartAt = appointment.start_at;

    const rescheduled = await this.appointments.reschedule(
      tenantId,
      null,
      appointment.id,
      { newStartAt: startAt },
      AppointmentActionOrigin.PATIENT,
    );

    await this.links.consume(link.id);

    // T045 (FR-R012) — attributable in the one existing audit trail, with
    // the previous and new times. Never the token, its digest, or patient
    // contact details.
    await this.appointmentAudit.record(
      APPOINTMENT_AUDIT_ACTION.RESCHEDULED_BY_PATIENT,
      tenantId,
      appointment.id,
      {
        origin: AppointmentActionOrigin.PATIENT,
        previousStartAt: previousStartAt.toISOString(),
        newStartAt: rescheduled.start_at.toISOString(),
      },
    );

    return rescheduled;
  }

  private durationMinutes(appointment: Appointment): number {
    const ms = appointment.end_at.getTime() - appointment.start_at.getTime();
    return Math.max(1, Math.round(ms / 60_000));
  }
}
