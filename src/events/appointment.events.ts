/**
 * Appointment domain events.
 *
 * These are fire-and-forget payloads emitted by AppointmentsService after
 * every successful state transition. Consumers (e.g. NotificationEventListener)
 * listen via @OnEvent() decorators without any direct import from the
 * appointments module — keeping the dependency graph acyclic.
 *
 * Payload policy: include only stable identifiers (UUIDs + scalars from the
 * saved aggregate). Consumers that need richer data should load it themselves
 * using the provided ids.
 * Clean Architecture وDomain-Driven Design
 * Open / Closed Principle
 * Loose Coupling
 */

export const APPOINTMENT_EVENT = {
  CREATED: 'appointment.created',
  CONFIRMED: 'appointment.confirmed',
  CANCELLED: 'appointment.cancelled',
  COMPLETED: 'appointment.completed',
  RESCHEDULED: 'appointment.rescheduled',
  NO_SHOW: 'appointment.no_show',
  IN_PROGRESS: 'appointment.in_progress',
  UPDATED: 'appointment.updated',
} as const;

export type AppointmentEventName =
  (typeof APPOINTMENT_EVENT)[keyof typeof APPOINTMENT_EVENT];

export class AppointmentCreatedEvent {
  static readonly eventName = APPOINTMENT_EVENT.CREATED;
  constructor(
    readonly tenantId: string,
    readonly appointmentId: string,
    readonly customerId: string,
    readonly staffId: string,
    readonly branchId: string,
    readonly startAt: Date,
  ) {}
}

export class AppointmentConfirmedEvent {
  static readonly eventName = APPOINTMENT_EVENT.CONFIRMED;
  constructor(
    readonly tenantId: string,
    readonly appointmentId: string,
    readonly customerId: string,
    readonly startAt: Date,
  ) {}
}

export class AppointmentCancelledEvent {
  static readonly eventName = APPOINTMENT_EVENT.CANCELLED;
  constructor(
    readonly tenantId: string,
    readonly appointmentId: string,
    readonly customerId: string,
    readonly reason: string | undefined,
  ) {}
}

export class AppointmentCompletedEvent {
  static readonly eventName = APPOINTMENT_EVENT.COMPLETED;
  constructor(
    readonly tenantId: string,
    readonly appointmentId: string,
    readonly customerId: string,
  ) {}
}

export class AppointmentRescheduledEvent {
  static readonly eventName = APPOINTMENT_EVENT.RESCHEDULED;
  constructor(
    readonly tenantId: string,
    readonly appointmentId: string,
    readonly customerId: string,
    readonly newStartAt: Date,
    /**
     * Spec 014 (Clinic Platform Completion) — T159 (US9, FR-W005). The
     * appointment row's own `start_at`/`end_at` now hold the NEW time, so
     * they can no longer answer "what time was just freed?" — these four
     * fields carry that snapshot, captured at the reschedule call site
     * before the row was updated, for `WaitlistListener` to enqueue
     * matching against. Optional (trailing) so the existing single-emit-site
     * contract widens without breaking any other constructor call.
     */
    readonly oldStartAt?: Date,
    readonly oldEndAt?: Date,
    readonly branchId?: string,
    readonly staffId?: string,
  ) {}
}

export class AppointmentNoShowEvent {
  static readonly eventName = APPOINTMENT_EVENT.NO_SHOW;
  constructor(
    readonly tenantId: string,
    readonly appointmentId: string,
    readonly customerId: string,
  ) {}
}

export class AppointmentInProgressEvent {
  static readonly eventName = APPOINTMENT_EVENT.IN_PROGRESS;
  constructor(
    readonly tenantId: string,
    readonly appointmentId: string,
    readonly customerId: string,
  ) {}
}

/** Branch/staff reassignment or notes edit — NOT a status transition (see the others above). */
export class AppointmentUpdatedEvent {
  static readonly eventName = APPOINTMENT_EVENT.UPDATED;
  constructor(
    readonly tenantId: string,
    readonly appointmentId: string,
    readonly customerId: string,
    readonly changes: string,
  ) {}
}
