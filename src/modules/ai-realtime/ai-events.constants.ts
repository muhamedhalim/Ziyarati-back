/**
 * Socket.IO event names for the realtime AI gateway (Feature 1). Client→server
 * events drive a turn / presence; server→client events stream the reply and
 * status. Kept in one place so the frontend + gateway never drift.
 */
export const AI_EVENT = {
  // ── connection / presence ──────────────────────────────────────────────
  CONNECTED: 'ai:connected',
  ERROR: 'ai:error',
  PRESENCE: 'ai:presence',
  // ── rooms ──────────────────────────────────────────────────────────────
  JOIN: 'ai:join',
  LEAVE: 'ai:leave',
  // ── message lifecycle ──────────────────────────────────────────────────
  MESSAGE: 'ai:message', // client → server: a user turn
  DELIVERED: 'ai:delivered', // server → client: turn received
  TYPING: 'ai:typing',
  SEEN: 'ai:seen',
  // ── AI streaming ───────────────────────────────────────────────────────
  THINKING: 'ai:thinking',
  TOKEN: 'ai:token', // server → client: one streamed delta
  DONE: 'ai:done', // server → client: final assistant message + usage
  // ── conversation / handover ────────────────────────────────────────────
  CONVERSATION_UPDATE: 'ai:conversation:update',
  HANDOVER: 'ai:handover',
  AGENT_JOINED: 'ai:agent:joined',
} as const;

export type AiEvent = (typeof AI_EVENT)[keyof typeof AI_EVENT];

/** Room helpers — strict tenant + conversation isolation. */
export const room = {
  tenant: (tenantId: string) => `tenant:${tenantId}`,
  conversation: (aiConversationId: string) => `conv:${aiConversationId}`,
};
