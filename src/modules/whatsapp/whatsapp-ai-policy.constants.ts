/**
 * Why the WhatsApp AI did NOT answer. A closed vocabulary: it is the `reason`
 * label on `whatsapp_ai_decisions_total` and the `reason=` field of the
 * `WHATSAPP_AI_DECISION` log line, so a code is only ever added here, never
 * built from data (a tenant id or a phone number must never become a label).
 */
export const AI_POLICY_REASON = {
  /** The clinic has no platform access at all (no subscription / free access). */
  SUBSCRIPTION_DISABLED: 'SUBSCRIPTION_DISABLED',
  /** Platform access is fine, but `ai.assistant` or `whatsapp` is not granted or is suspended. */
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  /** The clinic switched the assistant off (`tenant_settings.bot_enabled`). */
  CLINIC_AI_DISABLED: 'CLINIC_AI_DISABLED',
  /** This patient is excluded from the AI (`customers.ai_replies_disabled`). */
  PATIENT_AI_DISABLED: 'PATIENT_AI_DISABLED',
  /** Staff paused the AI on this conversation (`conversations.ai_mode = DISABLED`). */
  CONVERSATION_AI_DISABLED: 'CONVERSATION_AI_DISABLED',
  /**
   * A person owns the conversation: handover (`owner_type = HUMAN` /
   * `HANDED_OVER`), or a staff reply paused the AI for the clinic's takeover
   * window (`conversations.ai_paused_until` in the future).
   */
  HUMAN_TAKEOVER: 'HUMAN_TAKEOVER',
  /**
   * The clinic limits the AI to (or away from) its working hours and the current
   * moment is outside what is allowed (`tenant_settings.ai_schedule_mode`).
   */
  OUTSIDE_ALLOWED_HOURS: 'OUTSIDE_ALLOWED_HOURS',
  /**
   * The clinic answers with the AI only on conversations staff assigned to it
   * (`ai_assignment_mode = ASSIGNED_ONLY`) and this one is not.
   */
  NOT_ASSIGNED_TO_AI: 'NOT_ASSIGNED_TO_AI',
  /** A setting the decision depends on could not be read — fails closed. */
  POLICY_READ_FAILED: 'POLICY_READ_FAILED',
} as const;

export type AiPolicyReason =
  (typeof AI_POLICY_REASON)[keyof typeof AI_POLICY_REASON];

/**
 * Where in the turn the decision was taken. The same rules run at every stage;
 * the stage only says what was still avoidable:
 *  - `pre_ai`   — before the model is called (nothing has been spent);
 *  - `pre_send` — after the model answered, immediately before the WhatsApp send
 *    (a pause or takeover that landed during the turn must still stop the reply).
 */
export type AiPolicyStage = 'pre_ai' | 'pre_send';

/**
 * What the decision is about. Everything is optional: a message that could not
 * even be stored has no thread, and then only the clinic-wide rules apply.
 * These ids come from the server's own lookups, never from a client.
 */
export interface AiPolicySubject {
  /** The unified-timeline Conversation (owner_type, ai_mode, ai_paused_until live here). */
  conversationId?: string | null;
  /**
   * The patient. Optional: when absent it is taken from the conversation, so a
   * caller that only knows the thread is still covered by the patient rule.
   */
  customerId?: string | null;
  /** The contact's AI session (HANDED_OVER lives here). */
  aiConversationId?: string | null;
}

export type AiPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: AiPolicyReason };

/** `tenant_settings.ai_schedule_mode` — when the AI may answer. */
export const AI_SCHEDULE_MODE = {
  ALWAYS: 'ALWAYS',
  WORKING_HOURS: 'WORKING_HOURS',
  OUTSIDE_WORKING_HOURS: 'OUTSIDE_WORKING_HOURS',
} as const;
export type AiScheduleMode =
  (typeof AI_SCHEDULE_MODE)[keyof typeof AI_SCHEDULE_MODE];

/** `tenant_settings.ai_assignment_mode` — which conversations the AI answers. */
export const AI_ASSIGNMENT_MODE = {
  ALL: 'ALL',
  ASSIGNED_ONLY: 'ASSIGNED_ONLY',
} as const;
export type AiAssignmentMode =
  (typeof AI_ASSIGNMENT_MODE)[keyof typeof AI_ASSIGNMENT_MODE];
