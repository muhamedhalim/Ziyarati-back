/**
 * AI execution modes and the server-owned feature → mode policy.
 *
 * Two execution modes exist:
 *  - STANDARD: the synchronous OpenAI API. Used for anything a human is waiting
 *    on (booking chat, WhatsApp, live chat, tool calls, in-conversation RAG,
 *    appointment mutations).
 *  - BATCH: the asynchronous OpenAI Batch API. Used for non-interactive, cheaper
 *    bulk work (clinic reports, analytics, periodic evaluations, bulk file
 *    indexing, knowledge-base embedding, re-indexing).
 *
 * The mode is ALWAYS derived from the FEATURE (i.e. the call site / server route),
 * never from a request body. No DTO exposes an execution-mode field, so a client
 * can never opt into the more expensive (or the cheaper-but-slower) route. This
 * mirrors AiModelRouterService, which routes on feature/route and never on prompt
 * content.
 *
 * Data Residency is deliberately NOT modelled here — it is a compliance policy
 * (where a request is processed), orthogonal to WHICH execution mode is used. See
 * AiDataResidencyService.
 */

export const AI_EXECUTION_MODE = {
  STANDARD: 'STANDARD',
  BATCH: 'BATCH',
} as const;
export type AiExecutionMode =
  (typeof AI_EXECUTION_MODE)[keyof typeof AI_EXECUTION_MODE];

/**
 * Logical AI features. Each maps to exactly one execution mode. Names are stable
 * strings (persisted on batch jobs / cost entries), so do not rename in place.
 */
export const AI_FEATURE = {
  // ── Instant, human-in-the-loop → STANDARD ──────────────────────────────────
  BOOKING_CHAT: 'booking_chat',
  WHATSAPP_CHAT: 'whatsapp_chat',
  LIVE_CHAT: 'live_chat',
  TOOL_CALL: 'tool_call',
  RAG_QUERY: 'rag_query',
  APPOINTMENT_MUTATION: 'appointment_mutation',
  /** Generic instant chat turn (dashboard assistant, API). */
  CHAT: 'chat',
  /** Small file indexed immediately on upload (below the batch threshold). */
  FILE_INDEXING_STANDARD: 'file_indexing_standard',

  // ── Non-interactive, bulk / cheaper → BATCH ────────────────────────────────
  REPORT: 'report',
  ANALYTICS: 'analytics',
  EVALUATION: 'evaluation',
  BULK_EMBEDDING: 'bulk_embedding',
  /** Large training file indexed asynchronously (above the batch threshold). */
  FILE_INDEXING: 'file_indexing',
  KB_EMBEDDING: 'kb_embedding',
  REINDEX: 'reindex',
} as const;
export type AiFeature = (typeof AI_FEATURE)[keyof typeof AI_FEATURE];

/**
 * The single source of truth for feature → mode. Anything not listed defaults to
 * STANDARD (fail-safe: an unmapped feature is never silently sent to the async
 * batch route, which would strand a user-facing request behind a 24h window).
 */
export const FEATURE_EXECUTION_MODE: Readonly<Record<AiFeature, AiExecutionMode>> = {
  [AI_FEATURE.BOOKING_CHAT]: AI_EXECUTION_MODE.STANDARD,
  [AI_FEATURE.WHATSAPP_CHAT]: AI_EXECUTION_MODE.STANDARD,
  [AI_FEATURE.LIVE_CHAT]: AI_EXECUTION_MODE.STANDARD,
  [AI_FEATURE.TOOL_CALL]: AI_EXECUTION_MODE.STANDARD,
  [AI_FEATURE.RAG_QUERY]: AI_EXECUTION_MODE.STANDARD,
  [AI_FEATURE.APPOINTMENT_MUTATION]: AI_EXECUTION_MODE.STANDARD,
  [AI_FEATURE.CHAT]: AI_EXECUTION_MODE.STANDARD,
  [AI_FEATURE.FILE_INDEXING_STANDARD]: AI_EXECUTION_MODE.STANDARD,

  [AI_FEATURE.REPORT]: AI_EXECUTION_MODE.BATCH,
  [AI_FEATURE.ANALYTICS]: AI_EXECUTION_MODE.BATCH,
  [AI_FEATURE.EVALUATION]: AI_EXECUTION_MODE.BATCH,
  [AI_FEATURE.BULK_EMBEDDING]: AI_EXECUTION_MODE.BATCH,
  [AI_FEATURE.FILE_INDEXING]: AI_EXECUTION_MODE.BATCH,
  [AI_FEATURE.KB_EMBEDDING]: AI_EXECUTION_MODE.BATCH,
  [AI_FEATURE.REINDEX]: AI_EXECUTION_MODE.BATCH,
} as const;

/** OpenAI Batch API endpoints a batch job may target. */
export const AI_BATCH_ENDPOINT = {
  EMBEDDINGS: '/v1/embeddings',
  CHAT_COMPLETIONS: '/v1/chat/completions',
} as const;
export type AiBatchEndpoint =
  (typeof AI_BATCH_ENDPOINT)[keyof typeof AI_BATCH_ENDPOINT];

/**
 * Local batch-job lifecycle. A superset of OpenAI's statuses, plus PENDING (the
 * row exists before the remote batch is created) so submission itself is
 * crash-safe and idempotent.
 */
export const AI_BATCH_STATUS = {
  /** Row persisted; remote batch not yet created (pre-submission). */
  PENDING: 'PENDING',
  /** Uploaded input file + created remote batch; awaiting provider validation. */
  SUBMITTED: 'SUBMITTED',
  IN_PROGRESS: 'IN_PROGRESS',
  FINALIZING: 'FINALIZING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLING: 'CANCELLING',
  CANCELLED: 'CANCELLED',
} as const;
export type AiBatchStatus =
  (typeof AI_BATCH_STATUS)[keyof typeof AI_BATCH_STATUS];

/** Terminal statuses — no further polling; results (if any) are final. */
export const TERMINAL_BATCH_STATUSES: readonly AiBatchStatus[] = [
  AI_BATCH_STATUS.COMPLETED,
  AI_BATCH_STATUS.FAILED,
  AI_BATCH_STATUS.EXPIRED,
  AI_BATCH_STATUS.CANCELLED,
];

export function isTerminalBatchStatus(status: AiBatchStatus): boolean {
  return TERMINAL_BATCH_STATUSES.includes(status);
}

/** Per-request item status inside a batch. */
export const AI_BATCH_ITEM_STATUS = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type AiBatchItemStatus =
  (typeof AI_BATCH_ITEM_STATUS)[keyof typeof AI_BATCH_ITEM_STATUS];

/** Maps OpenAI's batch status string onto the local lifecycle. */
export function mapOpenAiBatchStatus(status: string): AiBatchStatus {
  switch (status) {
    case 'validating':
      return AI_BATCH_STATUS.SUBMITTED;
    case 'in_progress':
      return AI_BATCH_STATUS.IN_PROGRESS;
    case 'finalizing':
      return AI_BATCH_STATUS.FINALIZING;
    case 'completed':
      return AI_BATCH_STATUS.COMPLETED;
    case 'failed':
      return AI_BATCH_STATUS.FAILED;
    case 'expired':
      return AI_BATCH_STATUS.EXPIRED;
    case 'cancelling':
      return AI_BATCH_STATUS.CANCELLING;
    case 'cancelled':
      return AI_BATCH_STATUS.CANCELLED;
    default:
      // Unknown → treat as still in progress; the poller will re-check rather
      // than prematurely marking a live batch terminal.
      return AI_BATCH_STATUS.IN_PROGRESS;
  }
}
