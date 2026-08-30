import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Like, Not, Repository } from 'typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';

import { NotificationRuleService } from './notification-rule.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { RECIPIENT_TYPE, TERMINAL_STATUSES } from './notification.constants';
import { PatientActionLinkVariablesService } from './patient-action-link-variables.service';

/** The `source_ref` convention every reminder row is written under —
 *  `appointment-reminder:{appointmentId}:{leadMinutes}` — shared with
 *  `ReminderListener` (T052) and the reminders-visibility endpoint (T055),
 *  so it is defined once, here, rather than as a string literal in three
 *  places. */
export const reminderSourceRef = (
  appointmentId: string,
  leadMinutes: number,
): string => `appointment-reminder:${appointmentId}:${leadMinutes}`;

/** Parses the trailing `{leadMinutes}` segment from a reminder `source_ref`
 *  — the appointment id itself may contain no colons (it's a UUID), so the
 *  last segment is unambiguous. `null` for anything not in this shape. */
export function leadMinutesFromReminderSourceRef(
  sourceRef?: string | null,
): number | null {
  if (!sourceRef?.startsWith('appointment-reminder:')) return null;
  const parts = sourceRef.split(':');
  const value = Number(parts[parts.length - 1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Spec 014 (Clinic Platform Completion) — S3. The well-known `trigger_event`
 * a clinic attaches a `NotificationRule` + template to in order to author
 * reminder CONTENT (FR-M010, "a clinic-configurable template"). `reminders_
 * enabled`/`reminder_lead_minutes` (the Settings-tab toggle, T057) control
 * WHETHER and WHEN reminders fire; this constant is the seam between that
 * simple on/off control and the pre-existing rule/template authoring UI a
 * clinic already knows from every other notification — no new template
 * concept is introduced. Reminders with no active rule/template configured
 * for this event are simply never scheduled, matching the "no rule, no
 * dispatch" convention `NotificationEventListener` already documents.
 */
export const REMINDER_TRIGGER_EVENT = 'appointment.reminder';

/**
 * Spec 014 (Clinic Platform Completion) — T051 (S3, FR-M001–M005, FR-M013).
 * Turns a clinic's reminder settings into `ScheduledNotification` rows —
 * one per configured lead time, via the UNCHANGED
 * `NotificationSchedulerService.schedule`. Adds no new queue, job or
 * scheduler: the existing delayed dispatch and the minute-interval reap
 * sweep already provide delivery and recovery (FR-M014); the existing
 * `source_ref` partial-unique-index + catch-and-return-existing behaviour
 * already provides at-most-one-per-appointment-per-lead-time (FR-M013), for
 * free.
 */
@Injectable()
export class ReminderSchedulerService {
  private readonly logger = new Logger(ReminderSchedulerService.name);

  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    @InjectRepository(ScheduledNotification)
    private readonly scheduledNotifications: Repository<ScheduledNotification>,
    private readonly rules: NotificationRuleService,
    private readonly scheduler: NotificationSchedulerService,
    private readonly linkVariables: PatientActionLinkVariablesService,
  ) {}

  /**
   * Every non-terminal reminder row for an appointment (any lead time) —
   * the set `ReminderListener` (T052) acts on when the appointment is
   * cancelled, completed, marked no-show, or rescheduled.
   */
  async findActiveReminders(
    tenantId: string,
    appointmentId: string,
  ): Promise<ScheduledNotification[]> {
    return this.scheduledNotifications.find({
      where: {
        tenant: { id: tenantId },
        source_ref: Like(`appointment-reminder:${appointmentId}:%`),
        status: Not(In(TERMINAL_STATUSES)),
      },
    });
  }

  /**
   * Idempotent — safe to call more than once for the same appointment (e.g.
   * once on `AppointmentCreatedEvent`, again on `AppointmentConfirmedEvent`
   * for a manually-confirmed booking): every lead time's `source_ref` is
   * unique per appointment, so a repeat call is a harmless no-op for
   * whichever lead times are already scheduled.
   */
  async scheduleFor(tenantId: string, appointmentId: string): Promise<void> {
    const settings = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
    });
    const leadMinutesList = settings?.reminders_enabled
      ? (settings.reminder_lead_minutes ?? [])
      : [];
    if (leadMinutesList.length === 0) return;

    const appointment = await this.appointments.findOne({
      where: { id: appointmentId, tenant: { id: tenantId } },
      relations: { customer: true },
      select: { id: true, start_at: true, customer: { id: true } },
    });
    if (!appointment?.customer) return;

    const activeRules = await this.rules.findActiveByTrigger(
      tenantId,
      REMINDER_TRIGGER_EVENT,
    );
    const templateId = activeRules.find((r) => r.template)?.template?.id;
    if (!templateId) return; // FR-M010 — no clinic-configured template, nothing to send

    // T054 (FR-M017) — the same links the confirmation carries, so a
    // reminder never leaves the patient without a way to act on it. Issued
    // once per call (not once per lead time) — every lead time's reminder
    // for this appointment carries the same pair of fresh links.
    const linkVariables = await this.linkVariables.buildLinkVariables(
      tenantId,
      appointment,
    );

    for (const leadMinutes of leadMinutesList) {
      // FR-M004 — `start_at` is a `timestamptz` (an absolute instant)
      // captured at booking time; subtracting a fixed duration from it is
      // already timezone-correct and immune to a later branch-timezone
      // change, with nothing to convert.
      const scheduledAt = new Date(
        appointment.start_at.getTime() - leadMinutes * 60_000,
      );
      // FR-M005 — an appointment created closer to its start than this lead
      // time: skip, never send late.
      if (scheduledAt.getTime() <= Date.now()) continue;

      try {
        await this.scheduler.schedule(
          tenantId,
          {
            templateId,
            appointmentId: appointment.id,
            recipientType: RECIPIENT_TYPE.CUSTOMER,
            recipientId: appointment.customer.id,
            scheduledAt: scheduledAt.toISOString(),
          },
          reminderSourceRef(appointment.id, leadMinutes),
          linkVariables,
        );
      } catch (err) {
        // Log and continue — one lead time's failure must not suppress the
        // others (same reasoning as NotificationEventListener.dispatch).
        this.logger.error(
          `Failed to schedule a ${leadMinutes}min reminder for appointment ${appointmentId}: ${(err as Error)?.message}`,
        );
      }
    }
  }
}
