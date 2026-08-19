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
export const FEATURE_EXECUTION_MODE: Readonly<
  Record<AiFeature, AiExecutionMode>
> = {
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

/**
 * The logical feature for an interactive chat turn arriving on a given
 * conversation channel.
 *
 * Lives here, next to `AI_FEATURE` and `FEATURE_EXECUTION_MODE`, because it is
 * the join between the two: the channel is what an inbound turn actually
 * carries, and the feature is what every policy keys on. Callers pass the
 * conversation's own persisted `channel`, never a request-body value, so a
 * client cannot influence which policy its turn is evaluated under.
 *
 * Every branch — including the default — maps to a STANDARD-mode feature, so an
 * interactive turn can never be classified into the async BATCH route from here.
 * `AiProcessingPolicyService` enforces that independently as well.
 */
export function featureForChannel(channel: string): AiFeature {
  switch (channel.toUpperCase()) {
    case 'WHATSAPP':
      return AI_FEATURE.WHATSAPP_CHAT;
    // The public widget's whole purpose is discovery and booking, and it is the
    // only surface an unauthenticated visitor reaches.
    case 'WEBSITE':
      return AI_FEATURE.BOOKING_CHAT;
    default:
      return AI_FEATURE.CHAT;
  }
}

/**
 * What to do with a BATCH feature when the batch mode is disabled. Chosen so a
 * disabled flag can NEVER silently fan a large workload out as thousands of
 * synchronous requests or cause unexpected spend.
 */
export const BATCH_DISABLED_BEHAVIOR = {
  /** Refuse outright with a clear error (no synchronous alternative). */
  FAIL_CLOSED: 'FAIL_CLOSED',
  /** Run synchronously only when the workload is below a safe size; else fail. */
  USE_STANDARD_IF_SMALL: 'USE_STANDARD_IF_SMALL',
  /** Keep deferred — never convert to synchronous (large bulk / re-index). */
  DEFER: 'DEFER',
} as const;
export type BatchDisabledBehavior =
  (typeof BATCH_DISABLED_BEHAVIOR)[keyof typeof BATCH_DISABLED_BEHAVIOR];

/** Per-feature behavior when batch is disabled. Unmapped → USE_STANDARD_IF_SMALL. */
export const FEATURE_BATCH_DISABLED_BEHAVIOR: Readonly<
  Record<AiFeature, BatchDisabledBehavior>
> = {
  [AI_FEATURE.BOOKING_CHAT]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.WHATSAPP_CHAT]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.LIVE_CHAT]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.TOOL_CALL]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.RAG_QUERY]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.APPOINTMENT_MUTATION]:
    BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.CHAT]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.FILE_INDEXING_STANDARD]:
    BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  // Reports/analytics/evaluations MAY run synchronously when small enough.
  [AI_FEATURE.REPORT]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.ANALYTICS]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.EVALUATION]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  // A single large file may still index synchronously if small enough.
  [AI_FEATURE.FILE_INDEXING]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  [AI_FEATURE.KB_EMBEDDING]: BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL,
  // Bulk embeddings / re-index NEVER auto-convert to synchronous.
  [AI_FEATURE.BULK_EMBEDDING]: BATCH_DISABLED_BEHAVIOR.DEFER,
  [AI_FEATURE.REINDEX]: BATCH_DISABLED_BEHAVIOR.DEFER,
} as const;

/** Stable error reason surfaced when a required regional deployment is unavailable. */
export const AI_COMPLIANCE_ROUTE_UNAVAILABLE =
  'AI_COMPLIANCE_ROUTE_UNAVAILABLE';

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
  /** Row persisted; items not yet written (pre-submission). */
  PREPARING: 'PREPARING',
  /** Uploading the JSONL input file to the provider. */
  UPLOADING: 'UPLOADING',
  /** Input file uploaded (id saved); remote batch create in flight. */
  SUBMITTING: 'SUBMITTING',
  /**
   * The create call's outcome is UNKNOWN (network/timeout after the request was
   * sent). We must NOT create another remote batch — reconciliation verifies via
   * the correlation id before deciding.
   */
  SUBMISSION_UNKNOWN: 'SUBMISSION_UNKNOWN',
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

/** States the status poller advances (a remote batch exists). */
export const POLLABLE_BATCH_STATUSES: readonly AiBatchStatus[] = [
  AI_BATCH_STATUS.SUBMITTED,
  AI_BATCH_STATUS.IN_PROGRESS,
  AI_BATCH_STATUS.FINALIZING,
  AI_BATCH_STATUS.CANCELLING,
];

/** States the submission reconciler inspects (create outcome uncertain/incomplete). */
export const RECONCILE_SUBMISSION_STATUSES: readonly AiBatchStatus[] = [
  AI_BATCH_STATUS.UPLOADING,
  AI_BATCH_STATUS.SUBMITTING,
  AI_BATCH_STATUS.SUBMISSION_UNKNOWN,
];

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
