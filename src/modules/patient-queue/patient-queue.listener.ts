import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  AppointmentCancelledEvent,
} from '../../events/appointment.events';
import { PatientQueueService } from './patient-queue.service';

/**
 * Spec 014 (Clinic Platform Completion) — T173 (US10, FR-Q011). Reacts to
 * the ALREADY-EMITTED `AppointmentCancelledEvent` (no new event class) and
 * closes the entry's live queue row, if any, so a cancelled appointment can
 * never linger in a branch's live queue.
 *
 * Never throws from an `@OnEvent` handler — same reasoning as
 * `WaitlistListener`: a queue-cleanup hiccup here must not roll back or
 * otherwise interfere with the cancellation that triggered it.
 * `PatientQueueService.closeEntryForCancelledAppointment` is itself
 * idempotent (a conditional bulk UPDATE), so a retried/duplicate delivery of
 * this event is safe.
 */
@Injectable()
export class PatientQueueListener {
  private readonly logger = new Logger('PatientQueueListener');

  constructor(private readonly queue: PatientQueueService) {}

  @OnEvent(APPOINTMENT_EVENT.CANCELLED)
  async onAppointmentCancelled(
    event: AppointmentCancelledEvent,
  ): Promise<void> {
    try {
      await this.queue.closeEntryForCancelledAppointment(
        event.tenantId,
        event.appointmentId,
      );
    } catch (err) {
      this.logger.error(
        `Failed to close queue entry for cancelled appointment ${event.appointmentId}: ${(err as Error)?.message}`,
      );
    }
  }
}
