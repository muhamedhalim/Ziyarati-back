/**
 * Live Agent Handover domain events.
 *
 * Fire-and-forget payloads emitted by `HandoverRequestService` after every
 * lifecycle transition. Consumers (the realtime gateway's listener, the
 * notifications listener) subscribe via @OnEvent() without HandoverRequestService
 * (in AiModule) importing either of their modules — keeping the dependency
 * graph acyclic, exactly like AppointmentEvents / PaymentEvents.
 *
 * Payload policy: stable identifiers only (UUIDs + scalars). Consumers that
 * need richer data load it themselves.
 */

export const HANDOVER_EVENT = {
  REQUESTED: 'handover.requested',
  ASSIGNED: 'handover.assigned',
  ACCEPTED: 'handover.accepted',
  TRANSFERRED: 'handover.transferred',
  RETURNED_TO_AI: 'handover.returned_to_ai',
  RESOLVED: 'handover.resolved',
  REJECTED: 'handover.rejected',
  RELEASED: 'handover.released',
  CUSTOMER_REPLIED: 'handover.customer_replied',
  AGENT_REPLIED: 'handover.agent_replied',
  CLOSED: 'handover.conversation_closed',
} as const;

export type HandoverEventName = (typeof HANDOVER_EVENT)[keyof typeof HANDOVER_EVENT];

export class HandoverRequestedEvent {
  static readonly eventName = HANDOVER_EVENT.REQUESTED;
  constructor(
    readonly tenantId: string,
    readonly handoverId: string,
    readonly conversationId: string,
    readonly aiConversationId: string | undefined,
    readonly reason: string | undefined,
  ) {}
}

export class HandoverAssignedEvent {
  static readonly eventName = HANDOVER_EVENT.ASSIGNED;
  constructor(
    readonly tenantId: string,
    readonly handoverId: string,
    readonly conversationId: string,
    readonly assignedToUserId: string,
  ) {}
}

export class HandoverAcceptedEvent {
  static readonly eventName = HANDOVER_EVENT.ACCEPTED;
  constructor(
    readonly tenantId: string,
    readonly handoverId: string,
    readonly conversationId: string,
    readonly userId: string,
    /** Lets the realtime listener also notify the customer's own chat room
     *  (keyed by aiConversationId, NOT the messaging conversationId). */
    readonly aiConversationId: string | undefined,
  ) {}
}

export class HandoverTransferredEvent {
  static readonly eventName = HANDOVER_EVENT.TRANSFERRED;
  constructor(
    readonly tenantId: string,
    readonly handoverId: string,
    readonly conversationId: string,
    readonly fromUserId: string | undefined,
    readonly toUserId: string,
  ) {}
}

export class HandoverReturnedToAiEvent {
  static readonly eventName = HANDOVER_EVENT.RETURNED_TO_AI;
  constructor(
    readonly tenantId: string,
    readonly conversationId: string,
    readonly aiConversationId: string,
  ) {}
}

export class HandoverResolvedEvent {
  static readonly eventName = HANDOVER_EVENT.RESOLVED;
  constructor(
    readonly tenantId: string,
    readonly handoverId: string,
    readonly conversationId: string,
  ) {}
}

export class HandoverRejectedEvent {
  static readonly eventName = HANDOVER_EVENT.REJECTED;
  constructor(
    readonly tenantId: string,
    readonly handoverId: string,
    readonly conversationId: string,
    readonly reason: string | undefined,
  ) {}
}

export class HandoverReleasedEvent {
  static readonly eventName = HANDOVER_EVENT.RELEASED;
  constructor(
    readonly tenantId: string,
    readonly handoverId: string,
    readonly conversationId: string,
  ) {}
}

/** A customer message arrived while the conversation is HANDED_OVER (no AI reply). */
export class HandoverCustomerRepliedEvent {
  static readonly eventName = HANDOVER_EVENT.CUSTOMER_REPLIED;
  constructor(
    readonly tenantId: string,
    readonly conversationId: string,
    readonly aiConversationId: string,
    readonly assignedToUserId: string | undefined,
  ) {}
}

/** An agent sent a reply while owning the conversation. */
export class HandoverAgentRepliedEvent {
  static readonly eventName = HANDOVER_EVENT.AGENT_REPLIED;
  constructor(
    readonly tenantId: string,
    readonly conversationId: string,
    readonly aiConversationId: string | undefined,
    readonly userId: string,
    readonly content: string,
  ) {}
}

export class HandoverConversationClosedEvent {
  static readonly eventName = HANDOVER_EVENT.CLOSED;
  constructor(
    readonly tenantId: string,
    readonly conversationId: string,
  ) {}
}
