/**
 * AI channels + active-session shape (Phases 3 & 5).
 *
 * A single AI conversation model serves every channel; the orchestrator stamps
 * the `channel` and maintains the `session` (short-term active state) on the
 * existing `ai_conversations` row — no parallel per-channel store.
 */

export const AI_CHANNEL = {
  WEBSITE: 'WEBSITE', // public / internal website chat widget
  DASHBOARD: 'DASHBOARD', // clinic dashboard chat
  WHATSAPP: 'WHATSAPP', // WhatsApp Cloud API
  API: 'API', // programmatic REST
  MOBILE: 'MOBILE', // future mobile SDK
  VOICE: 'VOICE', // future voice
  TELEGRAM: 'TELEGRAM', // future
  MESSENGER: 'MESSENGER', // future
} as const;

export type AiChannel = (typeof AI_CHANNEL)[keyof typeof AI_CHANNEL];
export const AI_CHANNELS: AiChannel[] = Object.values(AI_CHANNEL);

/** Whether the end-user is authenticated within the conversation. */
export const AUTH_STATE = {
  ANONYMOUS: 'anonymous',
  AUTHENTICATED: 'authenticated',
} as const;
export type AuthState = (typeof AUTH_STATE)[keyof typeof AUTH_STATE];

/**
 * Active conversation state. Deliberately loose (`Record<string, unknown>` on the
 * entity) but typed here so the orchestrator + tools read/write a stable shape.
 * This is SESSION state (reset per conversation), NOT long-term memory.
 */
export interface AiSession {
  /** Currently selected clinic (tenant) once discovery resolves one. */
  selectedClinicId?: string;
  selectedBranchId?: string;
  selectedDoctorId?: string;
  /** Detected/declared intent for the current turn (e.g. `book_appointment`). */
  currentIntent?: string;
  /** Preferred language for this session (mirrors the column for tool access). */
  language?: string;
  /** Tool the session is mid-flow on (e.g. a multi-step booking). */
  currentTool?: string;
  /** Draft booking being assembled across turns. */
  currentBooking?: Record<string, unknown>;
  /** Authentication state of the end-user. */
  authState?: AuthState;
  /** Free-form working context carried between turns. */
  context?: Record<string, unknown>;

  // ── Omnichannel continuity (Feature 3) ──────────────────────────────────
  /** The channel this turn is being served on. */
  activeChannel?: AiChannel;
  /** The channel of the previous turn (to detect a channel switch). */
  lastChannel?: AiChannel;
  /** Ordered channel-switch history (capped) — one conversation, many channels. */
  channelHistory?: { channel: AiChannel; at: string }[];
  /** Client device descriptor (e.g. `web`, `ios`, `android`). */
  device?: string;
  /** IANA timezone of the end-user (e.g. `Africa/Cairo`). */
  timezone?: string;

  // ── Multi-agent routing (Feature 7) ─────────────────────────────────────
  /** Role of the agent currently handling the conversation. */
  currentAgentRole?: string;
}

/** How many channel-switch entries to retain in session history. */
export const CHANNEL_HISTORY_CAP = 25;

/**
 * Specialized AI agent roles (Feature 7). Stored on `ai_agents.role` (nullable);
 * the router maps intent/keywords → role → an active agent with that role.
 */
export const AGENT_ROLE = {
  RECEPTION: 'RECEPTION',
  BOOKING: 'BOOKING',
  MEDICAL_FAQ: 'MEDICAL_FAQ',
  BILLING: 'BILLING',
  CRM: 'CRM',
  REVIEW: 'REVIEW',
  MARKETING: 'MARKETING',
  SUPPORT: 'SUPPORT',
  DASHBOARD: 'DASHBOARD',
  SUPERVISOR: 'SUPERVISOR',
} as const;

export type AgentRole = (typeof AGENT_ROLE)[keyof typeof AGENT_ROLE];
export const AGENT_ROLES: AgentRole[] = Object.values(AGENT_ROLE);
