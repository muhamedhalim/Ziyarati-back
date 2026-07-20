/**
 * AI Batch execution domain events.
 *
 * Emitted by AiBatchService once a batch reaches a terminal state and its results
 * have been processed. Feature-specific finalizers (e.g. AiTrainingFileService,
 * which flips a large file to INDEXED only after ALL its embeddings are saved)
 * subscribe via @OnEvent() — so AiBatchService never imports those consumers and
 * the dependency graph stays acyclic (same pattern as the handover events).
 *
 * Payload policy: stable identifiers + scalar counters only. No prompt/response
 * content, no secrets.
 */

export const AI_BATCH_EVENT = {
  COMPLETED: 'ai.batch.completed',
} as const;

/** Fired when a batch job reaches a terminal status and results are applied. */
export class AiBatchCompletedEvent {
  static readonly eventName = AI_BATCH_EVENT.COMPLETED;
  constructor(
    readonly tenantId: string,
    readonly batchJobId: string,
    /** AI_FEATURE.* the batch was submitted for. */
    readonly feature: string,
    /** Terminal AI_BATCH_STATUS.* (COMPLETED / FAILED / EXPIRED / CANCELLED). */
    readonly status: string,
    readonly sourceType: string | null,
    readonly sourceId: string | null,
    readonly totalRequests: number,
    readonly completedRequests: number,
    readonly failedRequests: number,
  ) {}
}
