import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentConfirmedEvent,
  AppointmentCreatedEvent,
  AppointmentNoShowEvent,
  AppointmentRescheduledEvent,
} from '../../events/appointment.events';

import {
  ReminderSchedulerService,
  leadMinutesFromReminderSourceRef,
} from './reminder-scheduler.service';
import { NotificationSchedulerService } from './notification-scheduler.service';

/**
 * Spec 014 (Clinic Platform Completion) — T052 (S3, FR-M006/FR-M007).
 * Bridges the already-emitted appointment lifecycle events to
 * `ReminderSchedulerService`. Adds no new event class, no new queue.
 *
 * - CREATED/CONFIRMED → schedule (idempotent — see
 *   `ReminderSchedulerService.scheduleFor`'s own note; covers both the
 *   AUTO-confirm path, where CREATED already implies CONFIRMED, and the
 *   MANUAL-confirm path, where an appointment can sit PENDING for a while).
 * - CANCELLED/COMPLETED/NO_SHOW → cancel every pending reminder.
 * - RESCHEDULED → cancel or move every pending reminder to the new anchor,
 *   THEN re-run `scheduleFor` so a lead time that was originally too close
 *   to schedule (and so never got a row) gets a fresh chance against the
 *   new time.
 */
@Injectable()
export class ReminderListener {
  private readonly logger = new Logger(ReminderListener.name);

  constructor(
    private readonly reminders: ReminderSchedulerService,
    private readonly scheduler: NotificationSchedulerService,
  ) {}

  @OnEvent(APPOINTMENT_EVENT.CREATED)
  async onCreated(event: AppointmentCreatedEvent): Promise<void> {
    await this.schedule(event.tenantId, event.appointmentId);
  }

  @OnEvent(APPOINTMENT_EVENT.CONFIRMED)
  async onConfirmed(event: AppointmentConfirmedEvent): Promise<void> {
    await this.schedule(event.tenantId, event.appointmentId);
  }

  @OnEvent(APPOINTMENT_EVENT.CANCELLED)
  async onCancelled(event: AppointmentCancelledEvent): Promise<void> {
    await this.cancelAll(event.tenantId, event.appointmentId);
  }

  @OnEvent(APPOINTMENT_EVENT.COMPLETED)
  async onCompleted(event: AppointmentCompletedEvent): Promise<void> {
    await this.cancelAll(event.tenantId, event.appointmentId);
  }

  @OnEvent(APPOINTMENT_EVENT.NO_SHOW)
  async onNoShow(event: AppointmentNoShowEvent): Promise<void> {
    await this.cancelAll(event.tenantId, event.appointmentId);
  }

  @OnEvent(APPOINTMENT_EVENT.RESCHEDULED)
  async onRescheduled(event: AppointmentRescheduledEvent): Promise<void> {
    try {
      const active = await this.reminders.findActiveReminders(
        event.tenantId,
        event.appointmentId,
      );
      for (const row of active) {
        const leadMinutes = leadMinutesFromReminderSourceRef(row.source_ref);
        if (leadMinutes == null) continue;
        const newAnchor = new Date(
          new Date(event.newStartAt).getTime() - leadMinutes * 60_000,
        );
        try {
          if (newAnchor.getTime() <= Date.now()) {
            // FR-M005 — the moved appointment is now too close for this
            // lead time: cancel rather than send late.
            await this.scheduler.cancel(event.tenantId, row.id);
          } else {
            await this.scheduler.reschedule(event.tenantId, row.id, {
              scheduledAt: newAnchor.toISOString(),
            });
          }
        } catch (err) {
          this.logger.error(
            `Failed to re-anchor reminder ${row.id} for appointment ${event.appointmentId}: ${(err as Error)?.message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to load active reminders for appointment ${event.appointmentId}: ${(err as Error)?.message}`,
      );
    }

    // A lead time that never got a row (originally too close to the OLD
    // time) may now fit against the NEW time — no source_ref collision
    // since that lead time was never claimed.
    await this.schedule(event.tenantId, event.appointmentId);
  }

  private async schedule(
    tenantId: string,
    appointmentId: string,
  ): Promise<void> {
    try {
      await this.reminders.scheduleFor(tenantId, appointmentId);
    } catch (err) {
      this.logger.error(
        `Failed to schedule reminders for appointment ${appointmentId}: ${(err as Error)?.message}`,
      );
    }
  }

  private async cancelAll(
    tenantId: string,
    appointmentId: string,
  ): Promise<void> {
    try {
      const active = await this.reminders.findActiveReminders(
        tenantId,
        appointmentId,
      );
      for (const row of active) {
        try {
          await this.scheduler.cancel(tenantId, row.id);
        } catch (err) {
          this.logger.error(
            `Failed to cancel reminder ${row.id} for appointment ${appointmentId}: ${(err as Error)?.message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to load active reminders for appointment ${appointmentId}: ${(err as Error)?.message}`,
      );
    }
  }
}
