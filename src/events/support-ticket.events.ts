/**
 * Support-ticket domain events.
 *
 * `SupportTicketService` previously emitted nothing at all — it injects no
 * `EventEmitter2`, no notifier and no queue, so eight state-changing methods
 * produced zero signals and the only trace of a reply was a
 * `SupportTicketEvent` row nobody was told about. These events close that gap
 * the same way every other domain in this codebase does, following
 * `appointment.events.ts` exactly: a name constant, a class per event, a
 * `static readonly eventName`, and readonly constructor fields.
 *
 * ── WHY BOTH SIDES SHARE ONE `replied` EVENT ────────────────────────────────
 * A reply is one act; who performed it is an attribute of that act, not a
 * different act. `actorSide` carries it, and the listener maps the two sides to
 * two different catalog keys with different recipients. Emitting
 * `ticket.replied_by_platform` and `ticket.replied_by_tenant` instead would put
 * a routing decision into the producer, which is precisely the coupling the
 * notification catalog exists to prevent.
 *
 * ── WHY `eventId` IS ON EVERY EVENT ─────────────────────────────────────────
 * It is the id of the `SupportTicketEvent` row the action just wrote, and it is
 * what makes the notification idempotent: a second reply is legitimately a
 * second notification, but a redelivery of the SAME reply must not be. Keying
 * dedupe on the ticket id could not tell those apart; keying it on the event
 * row can.
 *
 * Emitted AFTER the write commits, so a listener can never observe a ticket
 * state that a later rollback would erase.
 */
export const SUPPORT_TICKET_EVENT = {
  CREATED: 'support_ticket.created',
  REPLIED: 'support_ticket.replied',
  STATUS_CHANGED: 'support_ticket.status_changed',
  REOPENED: 'support_ticket.reopened',
} as const;

export type SupportTicketEventName =
  (typeof SUPPORT_TICKET_EVENT)[keyof typeof SUPPORT_TICKET_EVENT];

/**
 * Which side of the conversation acted.
 *
 * `TENANT` = a clinic user; `PLATFORM` = super-admin or platform support. The
 * distinction decides who needs telling, so it is captured at the source rather
 * than inferred later from a role slug.
 */
export const TICKET_ACTOR_SIDE = {
  TENANT: 'TENANT',
  PLATFORM: 'PLATFORM',
} as const;

export type TicketActorSide =
  (typeof TICKET_ACTOR_SIDE)[keyof typeof TICKET_ACTOR_SIDE];

export class SupportTicketCreatedEvent {
  static readonly eventName = SUPPORT_TICKET_EVENT.CREATED;
  constructor(
    readonly tenantId: string,
    readonly ticketId: string,
    readonly ticketNumber: string,
    readonly subject: string,
    readonly priority: string,
    readonly category: string,
    readonly clinicName: string | null,
    /** The clinic user who opened it — excluded from recipients. */
    readonly actorUserId: string | null,
  ) {}
}

export class SupportTicketRepliedEvent {
  static readonly eventName = SUPPORT_TICKET_EVENT.REPLIED;
  constructor(
    readonly tenantId: string,
    readonly ticketId: string,
    readonly ticketNumber: string,
    readonly subject: string,
    readonly clinicName: string | null,
    /** Decides which side gets notified. */
    readonly actorSide: TicketActorSide,
    readonly actorUserId: string | null,
    readonly actorName: string | null,
    /** The reply text. The catalog truncates it; nothing here is rendered raw. */
    readonly note: string | null,
    /** `SupportTicketEvent.id` — the dedupe anchor. */
    readonly eventId: string,
  ) {}
}

export class SupportTicketStatusChangedEvent {
  static readonly eventName = SUPPORT_TICKET_EVENT.STATUS_CHANGED;
  constructor(
    readonly tenantId: string,
    readonly ticketId: string,
    readonly ticketNumber: string,
    readonly subject: string,
    readonly clinicName: string | null,
    readonly fromStatus: string,
    readonly toStatus: string,
    readonly actorSide: TicketActorSide,
    readonly actorUserId: string | null,
    readonly eventId: string,
  ) {}
}

/**
 * "Issue not resolved" — a clinic rejecting a resolution, which puts the ticket
 * back into the platform's active queue.
 *
 * Distinct from `STATUS_CHANGED` even though it also moves the status: the two
 * have opposite audiences (this one tells the platform; a platform-driven
 * status change tells the clinic) and different urgency. Collapsing them would
 * force the listener to re-derive intent from `fromStatus`/`toStatus`.
 */
export class SupportTicketReopenedEvent {
  static readonly eventName = SUPPORT_TICKET_EVENT.REOPENED;
  constructor(
    readonly tenantId: string,
    readonly ticketId: string,
    readonly ticketNumber: string,
    readonly subject: string,
    readonly clinicName: string | null,
    readonly actorUserId: string | null,
    readonly eventId: string,
  ) {}
}
