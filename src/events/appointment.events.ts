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
 */

export const APPOINTMENT_EVENT = {
  CREATED: 'appointment.created',
  CONFIRMED: 'appointment.confirmed',
  CANCELLED: 'appointment.cancelled',
  COMPLETED: 'appointment.completed',
  RESCHEDULED: 'appointment.rescheduled',
  NO_SHOW: 'appointment.no_show',
  IN_PROGRESS: 'appointment.in_progress',
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
