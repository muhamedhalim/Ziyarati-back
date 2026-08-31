import { Injectable } from '@nestjs/common';

import { ActivityAuditService } from '../activity-log/activity-audit.service';

/** FND-013-style convention (additive only; never repurpose an existing
 *  value) — mirrors `NOTIFICATION_AUDIT_ACTION`. */
export const APPOINTMENT_AUDIT_ACTION = {
  // Staff-initiated lifecycle. Emitted for every booking source EXCEPT
  // PUBLIC_AI (which has `BOOKED_PUBLICLY`), and — for cancel/reschedule —
  // only for STAFF-origin calls, since a patient acting on a signed link
  // already produces `CANCELLED_BY_PATIENT`/`RESCHEDULED_BY_PATIENT`. That
  // split is what stops one real-world event writing two audit rows.
  CREATED: 'appointment.created',
  UPDATED: 'appointment.updated',
  RESCHEDULED: 'appointment.rescheduled',
  CANCELLED: 'appointment.cancelled',
  STATUS_CHANGED: 'appointment.status_changed',
  // Patient / public paths.
  CANCELLED_BY_PATIENT: 'appointment.cancelled_by_patient',
  RESCHEDULED_BY_PATIENT: 'appointment.rescheduled_by_patient',
  BOOKED_PUBLICLY: 'appointment.booked_publicly',
} as const;

export type AppointmentAuditAction =
  (typeof APPOINTMENT_AUDIT_ACTION)[keyof typeof APPOINTMENT_AUDIT_ACTION];

/** Optional context for an appointment audit row. All fields are safe to
 *  omit — a caller that cannot cheaply resolve one must not go and fetch it
 *  just to log. */
export interface AppointmentAuditContext {
  /** The AUTHENTICATED actor. Omit for patient/system-driven paths. */
  actorUserId?: string | null;
  branchId?: string | null;
  /**
   * Short, non-sensitive label for the appointment — by convention the
   * treating staff member's name (an employee), NEVER the patient's name or
   * any contact detail. See `ActivityAuditService`'s rules.
   */
  entityLabel?: string | null;
  /** Small, structured, non-sensitive prior state (update actions only). */
  before?: Record<string, unknown> | null;
}

/**
 * Spec 014 (Clinic Platform Completion) — T034 (FR-G005). Records
 * appointment-domain actions to the shared `audit_logs` table. Best-effort:
 * a logging failure never blocks the appointment action it accompanies.
 *
 * The INSERT itself now goes through `ActivityAuditService` — one write path
 * for the whole clinic-wide activity stream — rather than a second hand-
 * rolled `auditLogs.save(...)` here. This service stays as the appointment
 * domain's typed front door: its three original call sites
 * (`patient-cancellation`, `patient-reschedule`, `public-booking-flow`) are
 * unchanged, since `details` and the new context are both optional.
 */
@Injectable()
export class AppointmentAuditService {
  constructor(private readonly activityAudit: ActivityAuditService) {}

  async record(
    action: AppointmentAuditAction,
    tenantId: string,
    appointmentId: string,
    details?: Record<string, unknown>,
    context: AppointmentAuditContext = {},
  ): Promise<void> {
    await this.activityAudit.record({
      tenantId,
      action,
      entityType: 'Appointment',
      entityId: appointmentId,
      // No actor by default — a patient action has no staff actor (same
      // reasoning as `cancelled_by` on `AppointmentCancellation`, T029).
      actorUserId: context.actorUserId ?? null,
      branchId: context.branchId ?? null,
      entityLabel: context.entityLabel ?? null,
      before: context.before ?? null,
      after: details ?? null,
    });
  }
}
