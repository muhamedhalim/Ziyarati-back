import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentNoShowEvent,
} from '../../events/appointment.events';

import { PatientActionLinkService } from './patient-action-link.service';

/**
 * Spec 014 (Clinic Platform Completion) — T033 (S1, FR-C003). A link stops
 * working the moment no action is possible on its appointment. Listens to
 * the ALREADY-EMITTED terminal-transition events — adds no new event.
 * `PatientActionLinkService.invalidateFor` is a conditional UPDATE (`WHERE
 * consumed_at IS NULL`), so replaying any of these is a safe no-op.
 */
@Injectable()
export class PatientActionListener {
  private readonly logger = new Logger(PatientActionListener.name);

  constructor(private readonly links: PatientActionLinkService) {}

  @OnEvent(APPOINTMENT_EVENT.CANCELLED)
  async onAppointmentCancelled(event: AppointmentCancelledEvent): Promise<void> {
    await this.invalidate(event.appointmentId);
  }

  @OnEvent(APPOINTMENT_EVENT.COMPLETED)
  async onAppointmentCompleted(event: AppointmentCompletedEvent): Promise<void> {
    await this.invalidate(event.appointmentId);
  }

  @OnEvent(APPOINTMENT_EVENT.NO_SHOW)
  async onAppointmentNoShow(event: AppointmentNoShowEvent): Promise<void> {
    await this.invalidate(event.appointmentId);
  }

  private async invalidate(appointmentId: string): Promise<void> {
    try {
      await this.links.invalidateFor(appointmentId);
    } catch (err) {
      // Log but never throw — a failed invalidation must not roll back or
      // otherwise interfere with the terminal transition that triggered it.
      this.logger.error(
        `Failed to invalidate patient action links for appointment ${appointmentId}: ${(err as Error)?.message}`,
      );
    }
  }
}
