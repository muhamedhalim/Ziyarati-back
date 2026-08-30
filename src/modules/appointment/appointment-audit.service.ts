import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

/** FND-013-style convention (additive only; never repurpose an existing
 *  value) — mirrors `NOTIFICATION_AUDIT_ACTION`. */
export const APPOINTMENT_AUDIT_ACTION = {
  CANCELLED_BY_PATIENT: 'appointment.cancelled_by_patient',
  RESCHEDULED_BY_PATIENT: 'appointment.rescheduled_by_patient',
  BOOKED_PUBLICLY: 'appointment.booked_publicly',
} as const;

export type AppointmentAuditAction =
  (typeof APPOINTMENT_AUDIT_ACTION)[keyof typeof APPOINTMENT_AUDIT_ACTION];

/**
 * Spec 014 (Clinic Platform Completion) — T034 (FR-G005). Records
 * appointment-domain actions to the shared `audit_logs` table, mirroring
 * `NotificationAuditService`'s pattern (this domain had no writer of its
 * own before this). Best-effort: a logging failure never blocks the
 * appointment action it accompanies.
 */
@Injectable()
export class AppointmentAuditService {
  private readonly logger = new Logger(AppointmentAuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(
    action: AppointmentAuditAction,
    tenantId: string,
    appointmentId: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: tenantId } as Tenant,
          // No `user` — a patient action has no staff actor (same
          // reasoning as `cancelled_by` on `AppointmentCancellation`, T029).
          action,
          entity_type: 'Appointment',
          entity_id: appointmentId,
          new_values: details,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Appointment audit write failed (${action}): ${(err as Error)?.message}`,
      );
    }
  }
}
