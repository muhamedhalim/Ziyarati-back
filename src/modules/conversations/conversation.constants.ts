/**
 * Conversation lifecycle status. `Conversation.status` is a free `varchar`
 * (entity default `'BOT'`), so these are app-defined (no DB enum / no schema
 * change). There is no `deleted_at` column → "archive" is the ARCHIVED status,
 * and "delete" is a hard delete (CASCADE removes participants/messages).
 */
export const CONVERSATION_STATUS = {
  BOT: 'BOT',
  OPEN: 'OPEN',
  ASSIGNED: 'ASSIGNED',
  RESOLVED: 'RESOLVED',
  ARCHIVED: 'ARCHIVED',
  CLOSED: 'CLOSED',
} as const;

export type ConversationStatus =
  (typeof CONVERSATION_STATUS)[keyof typeof CONVERSATION_STATUS];

export const CONVERSATION_STATUSES: ConversationStatus[] =
  Object.values(CONVERSATION_STATUS);

/** Statuses considered "active" (open work) for analytics. */
export const ACTIVE_CONVERSATION_STATUSES: ConversationStatus[] = [
  CONVERSATION_STATUS.BOT,
  CONVERSATION_STATUS.OPEN,
  CONVERSATION_STATUS.ASSIGNED,
];

/** Statuses considered "resolved" for resolution-rate analytics. */
export const RESOLVED_CONVERSATION_STATUSES: ConversationStatus[] = [
  CONVERSATION_STATUS.RESOLVED,
  CONVERSATION_STATUS.CLOSED,
];

/** Live Agent Handover ownership. `Conversation.owner_type` default 'AI'. */
export const CONVERSATION_OWNER_TYPE = {
  AI: 'AI',
  HUMAN: 'HUMAN',
} as const;

export type ConversationOwnerType =
  (typeof CONVERSATION_OWNER_TYPE)[keyof typeof CONVERSATION_OWNER_TYPE];

/** Conversation kind. `Conversation.type` is a free `varchar`. */
export const CONVERSATION_TYPE = {
  DIRECT: 'direct',
  GROUP: 'group',
  SUPPORT: 'support',
  AUTOMATION: 'automation',
} as const;

export type ConversationType =
  (typeof CONVERSATION_TYPE)[keyof typeof CONVERSATION_TYPE];

export const CONVERSATION_TYPES: ConversationType[] =
  Object.values(CONVERSATION_TYPE);

/** Message body kind. `Message.message_type` default is `'text'`. */
export const MESSAGE_TYPE = {
  TEXT: 'text',
  IMAGE: 'image',
  FILE: 'file',
  SYSTEM: 'system',
} as const;

export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];
export const MESSAGE_TYPES: MessageType[] = Object.values(MESSAGE_TYPE);

/** Who/what sent a message (matches `Message.sender_type`). */
export const SENDER_TYPE = {
  CUSTOMER: 'CUSTOMER',
  AGENT: 'AGENT',
  BOT: 'BOT',
  SYSTEM: 'SYSTEM',
} as const;

export type SenderType = (typeof SENDER_TYPE)[keyof typeof SENDER_TYPE];

/** Sender types allowed when sending via the staff API. */
export const API_SENDABLE_SENDER_TYPES: SenderType[] = [
  SENDER_TYPE.AGENT,
  SENDER_TYPE.BOT,
  SENDER_TYPE.SYSTEM,
];

/** Message delivery states recorded on `message_status_logs`. */
export const MESSAGE_STATUS = {
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
} as const;

export type MessageStatus = (typeof MESSAGE_STATUS)[keyof typeof MESSAGE_STATUS];
export const MESSAGE_STATUSES: MessageStatus[] = Object.values(MESSAGE_STATUS);
