import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentConfirmedEvent,
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
 * - CONFIRMED → schedule (idempotent — see `ReminderSchedulerService.
 *   scheduleFor`'s own note). Covers the MANUAL-confirm path, where an
 *   appointment sits PENDING_PAYMENT for a while before a staff action (or
 *   a verified payment) confirms it. **CREATED is deliberately NOT handled
 *   here as of P1.5 (MS-007)** — the AUTO-confirm path (CREATED already
 *   implies CONFIRMED) now schedules reminders via a transactional outbox
 *   row written inside `AppointmentsService.create`'s own transaction,
 *   consumed by `NotificationsProcessor`'s `reminders.schedule` job. That
 *   closes what this listener could not: it needed 3-4 fresh DB reads
 *   AFTER the booking transaction already committed, competing for a pool
 *   connection against live request traffic — under saturation it lost
 *   that race and the reminder was silently never scheduled (MS-007,
 *   measured: ~2.5% of bookings at the load test's saturated levels). A
 *   CONFIRMED transition happens later, one appointment at a time via a
 *   deliberate action, never in the same booking-creation burst — it kept
 *   the simpler listener path rather than being moved too, since it was
 *   never observed to have this problem.
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
