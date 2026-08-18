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
  // ── Public booking selections (SERVER-WRITE-ONLY) ────────────────────────
  // Written only by the validated `select_*` tools via
  // `PublicBookingContextService.patchSelection`, never by a client patch (see
  // SESSION_CLIENT_PATCHABLE_KEYS). This matters beyond tidiness: the clinic
  // tenant for a public booking is DERIVED from `selectedBranchId`, so a
  // client-writable value would be an indirect `tenantId` injection — the one
  // thing the whole design refuses to accept from outside.

  /** Currently selected clinic (tenant) once discovery resolves one. */
  selectedClinicId?: string;
  selectedBranchId?: string;
  selectedDoctorId?: string;
  /** Services chosen for the booking; priced per-branch at write time. */
  selectedServiceIds?: string[];
  /** Chosen slot start, ISO-8601 with offset. Re-validated before it is used. */
  selectedStartAt?: string;
  /**
   * The customer resolved/created inside the SELECTED clinic's tenant. Bound
   * server-side so the dispatcher can prefer it over any model-supplied id.
   */
  bookingCustomerId?: string;
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

  /**
   * The guest-token `sub` that created this conversation, recorded only when the
   * acting principal is scoped to the guest discovery tenant (FND-001).
   *
   * This is the source-conversation ownership binding: guest conversion compares
   * it against the `sub` of the verified `guest_token`. It is written once at
   * creation and never updated. **Absence means NOT convertible (fail closed)** —
   * never "unowned, therefore allowed". Conversations created before this field
   * existed carry no value and are deliberately non-convertible.
   */
  guestSubject?: string;

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

  /**
   * AI-019 (FR-072-FR-074, F1, PD-1): outstanding application-issued
   * confirmation tokens for irreversible appointment actions, keyed by
   * `<action>:<appointmentId>` (e.g. `cancel:<uuid>`). SERVER-WRITE-ONLY
   * (absent from SESSION_CLIENT_PATCHABLE_KEYS) — a client-writable value
   * would let a caller forge its own "confirmed" state, which is exactly
   * what FR-073 forbids. Written and consumed only by
   * `AiToolDispatchService`'s confirmation gate on `cancel_appointment` /
   * `reschedule_appointment`. Single-use: deleted from this map the moment
   * it is successfully verified, so a captured token cannot be replayed.
   */
  pendingConfirmations?: Record<
    string,
    { token: string; expiresAt: string }
  >;
}

/** How many channel-switch entries to retain in session history. */
export const CHANNEL_HISTORY_CAP = 25;

/**
 * The ONLY top-level `AiSession` keys a client may set through a
 * `sessionPatch` / `PatchSessionDto` body.
 *
 * Everything absent from this list is SERVER-WRITE-ONLY, because it is either
 * security-bearing or authoritative booking state:
 *
 *  - `guestSubject` — the FND-001 ownership binding. A client that could write
 *    it could adopt another guest's conversation, which is exactly what
 *    `AiConversationAccessService` uses it to prevent.
 *  - `selected*` — the resolved booking selections. The clinic tenant for a
 *    public booking is derived from `selectedBranchId`, so a writable value
 *    would be an indirect `tenantId` injection. Only validated server code
 *    (the `select_*` tools) may set these.
 *  - `activeChannel` / `lastChannel` / `channelHistory` — owned by
 *    `ConversationSessionService.touchChannel`.
 *  - `currentAgentRole` — owned by the agent router via `setAgent`.
 *
 * Enforced by `ConversationSessionService.patchFromClient`, which is the only
 * method any client-facing path may call.
 */
export const SESSION_CLIENT_PATCHABLE_KEYS = [
  'currentIntent',
  'language',
  'currentTool',
  'currentBooking',
  'authState',
  'context',
  'device',
  'timezone',
] as const satisfies readonly (keyof AiSession)[];

/**
 * Keys stripped from a CLIENT-supplied `session.context` blob.
 *
 * `context.customerId` is the server-bound booking subject: `ToolContext`
 * reads it (see `AiExecutionService.sessionCustomerId`) and the dispatcher
 * prefers it over any model-supplied id, so a client-writable value would let
 * an attacker bind a stranger's customer record to their own conversation.
 * `recalledMemories` is written by the orchestrator's memory loader.
 */
export const SESSION_CONTEXT_SERVER_ONLY_KEYS = [
  'customerId',
  'recalledMemories',
] as const;

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
