import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AI_EXECUTION_MODE,
  AiExecutionMode,
  AiFeature,
  BATCH_DISABLED_BEHAVIOR,
  BatchDisabledBehavior,
  FEATURE_BATCH_DISABLED_BEHAVIOR,
  FEATURE_EXECUTION_MODE,
} from './ai-execution.constants';

/** The concrete action for an embedding/indexing workload. */
export type EmbeddingAction = 'RUN' | 'DEFER' | 'FAIL';

export interface EmbeddingExecutionDecision {
  /** Mode to run in when `action === 'RUN'`. */
  mode: AiExecutionMode;
  action: EmbeddingAction;
  reason: string;
}

export interface ModeDecision {
  mode: AiExecutionMode;
  feature: AiFeature;
  /** Why this mode was chosen (telemetry / debugging; never patient content). */
  reason: string;
}

/**
 * Decides the execution mode (STANDARD vs BATCH) for a feature.
 *
 * The decision is a pure function of the FEATURE — which is fixed at the call
 * site — so neither the frontend nor an end user can select the cheaper-but-slow
 * batch route (or force the expensive synchronous route). This is the enforcement
 * point the requirement calls for: "Do not allow the frontend or user to choose
 * the most expensive route."
 *
 * BATCH is additionally gated by a master feature flag (AI_BATCH_ENABLED, default
 * OFF). When batch is disabled the classifier degrades a BATCH feature back to
 * STANDARD, so the whole system keeps working via the existing synchronous path
 * and the change is fully revertable by flipping one env var.
 */
@Injectable()
export class AiExecutionPolicyService {

  constructor(private readonly config: ConfigService) {}

  /** True when the OpenAI Batch execution mode is enabled platform-wide. */
  isBatchEnabled(): boolean {
    return String(this.config.get('AI_BATCH_ENABLED', 'false')) === 'true';
  }

  /**
   * Resolve the mode for a feature. Unmapped features fail safe to STANDARD (an
   * unknown feature must never be stranded behind the async batch window).
   */
  resolveMode(feature: AiFeature): ModeDecision {
    const intended =
      FEATURE_EXECUTION_MODE[feature] ?? AI_EXECUTION_MODE.STANDARD;
    if (intended === AI_EXECUTION_MODE.BATCH && !this.isBatchEnabled()) {
      return {
        mode: AI_EXECUTION_MODE.STANDARD,
        feature,
        reason: 'batch_disabled_fallback_standard',
      };
    }
    return {
      mode: intended,
      feature,
      reason:
        intended === AI_EXECUTION_MODE.BATCH
          ? 'feature_batch'
          : 'feature_standard',
    };
  }

  /** Convenience predicate: would this feature run as BATCH right now? */
  isBatch(feature: AiFeature): boolean {
    return this.resolveMode(feature).mode === AI_EXECUTION_MODE.BATCH;
  }

  /**
   * The chunk count at or above which an embedding/indexing job should prefer the
   * BATCH route. Configurable per requirement ("Make limits, such as the number
   * of chunks that trigger Batch, configurable from Environment Variables").
   */
  batchChunkThreshold(): number {
    const raw = Number(
      this.config.get('AI_BATCH_EMBEDDING_CHUNK_THRESHOLD', 200),
    );
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
  }

  /**
   * Decide whether an embedding workload of `chunkCount` chunks should use BATCH.
   * Requires: batch enabled AND at/above the configured threshold. `forceBatch`
   * (re-indexing / explicit bulk) bypasses the threshold but still respects the
   * master flag.
   */
  shouldBatchEmbeddings(chunkCount: number, forceBatch = false): boolean {
    if (!this.isBatchEnabled()) return false;
    if (forceBatch) return true;
    return chunkCount >= this.batchChunkThreshold();
  }

  /** Max chunks a single workload may embed SYNCHRONOUSLY (safety cap). */
  standardMaxEmbedChunks(): number {
    const raw = Number(this.config.get('AI_STANDARD_MAX_EMBED_CHUNKS', 512));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 512;
  }

  /**
   * Resolve how an embedding/indexing workload should run, honoring the
   * per-feature batch-disabled policy. This is the guard against a disabled flag
   * silently fanning a large job out synchronously (unexpected cost) or forcing
   * a huge single request:
   *
   *  - Batch ENABLED: BATCH at/above the threshold (or when forced), else STANDARD.
   *  - Batch DISABLED:
   *      • DEFER features (bulk/re-index) → never convert; action = DEFER.
   *      • USE_STANDARD_IF_SMALL → STANDARD only when ≤ standardMaxEmbedChunks,
   *        else action = FAIL (too large; do not run synchronously).
   *      • FAIL_CLOSED → action = FAIL.
   */
  resolveEmbeddingExecution(
    feature: AiFeature,
    chunkCount: number,
    opts: { forceBatch?: boolean } = {},
  ): EmbeddingExecutionDecision {
    if (this.isBatchEnabled()) {
      if (opts.forceBatch || chunkCount >= this.batchChunkThreshold()) {
        return {
          mode: AI_EXECUTION_MODE.BATCH,
          action: 'RUN',
          reason: 'batch_enabled',
        };
      }
      return {
        mode: AI_EXECUTION_MODE.STANDARD,
        action: 'RUN',
        reason: 'below_batch_threshold',
      };
    }

    const behavior: BatchDisabledBehavior =
      FEATURE_BATCH_DISABLED_BEHAVIOR[feature] ??
      BATCH_DISABLED_BEHAVIOR.USE_STANDARD_IF_SMALL;

    if (behavior === BATCH_DISABLED_BEHAVIOR.DEFER) {
      return {
        mode: AI_EXECUTION_MODE.BATCH,
        action: 'DEFER',
        reason: 'batch_disabled_deferred',
      };
    }
    if (behavior === BATCH_DISABLED_BEHAVIOR.FAIL_CLOSED) {
      return {
        mode: AI_EXECUTION_MODE.BATCH,
        action: 'FAIL',
        reason: 'batch_disabled_fail_closed',
      };
    }
    // USE_STANDARD_IF_SMALL
    if (chunkCount <= this.standardMaxEmbedChunks()) {
      return {
        mode: AI_EXECUTION_MODE.STANDARD,
        action: 'RUN',
        reason: 'batch_disabled_small_standard',
      };
    }
    return {
      mode: AI_EXECUTION_MODE.BATCH,
      action: 'FAIL',
      reason: 'batch_disabled_too_large_for_standard',
    };
  }
}
