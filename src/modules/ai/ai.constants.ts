/**
 * AI domain app-level constants.
 *
 * Schema notes (no DB change):
 *  - `ai_agents` has only `is_active` + a soft-delete column → lifecycle maps to
 *    is_active (active/inactive) and soft-delete (archived); "draft" is not a
 *    distinct persisted state.
 *  - `ai_knowledge_bases` has no status/name column → a row is a knowledge CHUNK
 *    per agent; statuses below are conceptual only.
 *  - `ai_prompts` has no type/version column → prompt type/version are not
 *    persisted.
 *  - `ai_training_files.status`, `ai_conversations.status`,
 *    `handover_requests.status` are free varchars → app-defined below.
 */

/**
 * Clinic directives (`ai_prompts` rows). They are sent to the model on every
 * turn, so the bounds are what keep a clinic's standing rules from growing into
 * an unbounded per-turn token cost. 10 x 400 chars is about 1500 tokens by the
 * prompt budget's estimator, which is what the default
 * `AI_PROMPT_DIRECTIVES_TOKENS` is sized to hold.
 */
export const AI_DIRECTIVE_LIMITS = {
  /** Longest single directive (create/update validation and runtime clip). */
  MAX_CONTENT_CHARS: 400,
  /** Active directives per clinic that reach the model. */
  MAX_ACTIVE: 10,
  /** Stored directives per clinic, active or not. */
  MAX_TOTAL: 50,
} as const;

/** Training-file ingestion status (free varchar; default replaced from 'PENDING'). */
export const TRAINING_FILE_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  INDEXED: 'INDEXED',
  FAILED: 'FAILED',
} as const;
export type TrainingFileStatus =
  (typeof TRAINING_FILE_STATUS)[keyof typeof TRAINING_FILE_STATUS];
export const TRAINING_FILE_STATUSES: TrainingFileStatus[] =
  Object.values(TRAINING_FILE_STATUS);

/** Supported training-file types (validation only). */
export const SUPPORTED_FILE_TYPES = ['PDF', 'DOCX', 'TXT', 'MD'] as const;

/** AI conversation status (free varchar; default 'ACTIVE'). */
export const AI_CONVERSATION_STATUS = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  HANDED_OVER: 'HANDED_OVER',
  ARCHIVED: 'ARCHIVED',
  /**
   * Terminal for guest conversion (FND-001). Set by a conditional UPDATE guarded
   * on `status = 'ACTIVE'`, so a concurrent or repeated conversion affects zero
   * rows and is rejected — at most one memory record is ever written.
   */
  CONVERTED: 'CONVERTED',
} as const;
export type AiConversationStatus =
  (typeof AI_CONVERSATION_STATUS)[keyof typeof AI_CONVERSATION_STATUS];
export const AI_CONVERSATION_STATUSES: AiConversationStatus[] =
  Object.values(AI_CONVERSATION_STATUS);

/**
 * F-14: the longest user message any AI transport accepts, in characters.
 *
 * ONE number for every door. The REST DTOs capped `content` at 8000 while the
 * WebSocket — the transport the public widget and the dashboard actually use —
 * checked only that it was non-empty, so the same text a REST call refused was
 * accepted, persisted, embedded for retrieval and billed on the socket. The DTOs
 * and the gateway both read this so the two cannot drift apart again.
 */
export const AI_MESSAGE_MAX_CHARS = 8000;

/** AI message roles (free varchar). */
export const AI_MESSAGE_ROLE = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
} as const;
export type AiMessageRole = (typeof AI_MESSAGE_ROLE)[keyof typeof AI_MESSAGE_ROLE];
export const AI_MESSAGE_ROLES: AiMessageRole[] = Object.values(AI_MESSAGE_ROLE);

/** Handover request lifecycle (free varchar; default 'PENDING'). */
export const HANDOVER_STATUS = {
  PENDING: 'PENDING',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  RESOLVED: 'RESOLVED',
  REJECTED: 'REJECTED',
} as const;
export type HandoverStatus =
  (typeof HANDOVER_STATUS)[keyof typeof HANDOVER_STATUS];
export const HANDOVER_STATUSES: HandoverStatus[] = Object.values(HANDOVER_STATUS);

/** Terminal handover statuses. */
export const TERMINAL_HANDOVER_STATUSES: HandoverStatus[] = [
  HANDOVER_STATUS.RESOLVED,
  HANDOVER_STATUS.REJECTED,
];

/** Current billing period key, e.g. "2026-06". */
export function currentPeriodMonth(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
