import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AI_EXECUTION_MODE,
  AiExecutionMode,
  AiFeature,
  FEATURE_EXECUTION_MODE,
} from './ai-execution.constants';

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
  private readonly logger = new Logger(AiExecutionPolicyService.name);

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
    const intended = FEATURE_EXECUTION_MODE[feature] ?? AI_EXECUTION_MODE.STANDARD;
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
        intended === AI_EXECUTION_MODE.BATCH ? 'feature_batch' : 'feature_standard',
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
    const raw = Number(this.config.get('AI_BATCH_EMBEDDING_CHUNK_THRESHOLD', 200));
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
}
