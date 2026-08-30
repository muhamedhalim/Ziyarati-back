import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  AppointmentCancelledEvent,
  AppointmentRescheduledEvent,
} from '../../events/appointment.events';

import { QueueService } from '../../queue/queue.service';

/**
 * Spec 014 (Clinic Platform Completion) — T159 (US9, FR-W005). Reacts to
 * freed time WITHOUT touching the appointment module's write paths: it only
 * consumes the ALREADY-EMITTED `AppointmentCancelledEvent` /
 * `AppointmentRescheduledEvent` and enqueues `platform.waitlistEvaluate` so
 * evaluation runs off the request path (on the worker, T160). Adds no new
 * event class.
 *
 * Never throws from an `@OnEvent` handler — a queue hiccup here must not
 * roll back or otherwise interfere with the cancellation/reschedule that
 * triggered it; a missed evaluation is a bounded, recoverable gap (the NEXT
 * freed slot for the same service re-evaluates the same waiting entries),
 * never a reason to fail someone else's write.
 */
@Injectable()
export class WaitlistListener {
  private readonly logger = new Logger('WaitlistListener');

  constructor(private readonly queue: QueueService) {}

  @OnEvent(APPOINTMENT_EVENT.CANCELLED)
  async onAppointmentCancelled(
    event: AppointmentCancelledEvent,
  ): Promise<void> {
    // The cancelled appointment's own row still holds the freed
    // (branch, staff, start, end) unchanged — no override needed.
    await this.enqueue(event.tenantId, event.appointmentId);
  }

  @OnEvent(APPOINTMENT_EVENT.RESCHEDULED)
  async onAppointmentRescheduled(
    event: AppointmentRescheduledEvent,
  ): Promise<void> {
    // The appointment's row now holds the NEW time — the freed (old) window
    // only survives on the event itself (see AppointmentRescheduledEvent's
    // docblock). Skip if the emit site didn't supply it (defensive; the
    // real `AppointmentsService.reschedule` emit site always does).
    if (
      !event.oldStartAt ||
      !event.oldEndAt ||
      !event.branchId ||
      !event.staffId
    ) {
      this.logger.warn(
        `AppointmentRescheduledEvent for appointment ${event.appointmentId} is missing its freed-slot snapshot — skipping waitlist evaluation`,
      );
      return;
    }
    await this.enqueue(event.tenantId, event.appointmentId, {
      freedStartAt: event.oldStartAt.toISOString(),
      freedEndAt: event.oldEndAt.toISOString(),
      freedBranchId: event.branchId,
      freedStaffId: event.staffId,
    });
  }

  private async enqueue(
    tenantId: string,
    appointmentId: string,
    freed?: {
      freedStartAt: string;
      freedEndAt: string;
      freedBranchId: string;
      freedStaffId: string;
    },
  ): Promise<void> {
    try {
      await this.queue.enqueueWaitlistEvaluate({
        tenantId,
        appointmentId,
        ...freed,
      });
    } catch (err) {
      this.logger.error(
        `Failed to enqueue waitlist evaluation for appointment ${appointmentId}: ${(err as Error)?.message}`,
      );
    }
  }
}
