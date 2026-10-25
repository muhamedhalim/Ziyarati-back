import { Like, type Repository } from 'typeorm';

import type { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { leadMinutesFromReminderSourceRef } from './reminder-scheduler.service';

/** Spec 014 (Clinic Platform Completion) — T055 (S3, FR-M015). One
 *  reminder row (any lead time) for an appointment. */
export interface ReminderView {
  id: string;
  leadMinutes: number | null;
  scheduledAt: Date;
  status: string;
  channel: string | null;
  skipReason: string | null;
  failureReason: string | null;
}

/**
 * Projects an appointment's reminders from `scheduled_notifications`, filtered
 * by the `source_ref` convention `ReminderSchedulerService` writes under
 * (`appointment-reminder:{id}:%`) — no new storage.
 *
 * Lives beside the scheduler so the notifications domain, not the appointment
 * service, owns that convention and the table's columns. It takes the
 * repository rather than being a provider because `NotificationsModule`
 * already (transitively, via PatientActions) imports `AppointmentModule`: a
 * module-level dependency back would be a cycle. The caller proves the
 * appointment belongs to the tenant BEFORE calling this.
 */
export async function listAppointmentReminders(
  scheduledNotifications: Repository<ScheduledNotification>,
  tenantId: string,
  appointmentId: string,
): Promise<ReminderView[]> {
  const rows = await scheduledNotifications.find({
    where: {
      tenant: { id: tenantId },
      source_ref: Like(`appointment-reminder:${appointmentId}:%`),
    },
    order: { scheduled_at: 'ASC' },
  });

  return rows.map((row) => ({
    id: row.id,
    leadMinutes: leadMinutesFromReminderSourceRef(row.source_ref ?? null),
    scheduledAt: row.scheduled_at,
    status: row.status,
    channel: row.channel ?? null,
    skipReason: row.skip_reason ?? null,
    failureReason: row.failure_reason ?? null,
  }));
}
