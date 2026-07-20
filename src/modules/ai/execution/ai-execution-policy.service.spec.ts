import { ConfigService } from '@nestjs/config';

import { AiExecutionPolicyService } from './ai-execution-policy.service';
import { AI_EXECUTION_MODE, AI_FEATURE } from './ai-execution.constants';

describe('AiExecutionPolicyService', () => {
  const make = (env: Record<string, unknown> = {}) =>
    new AiExecutionPolicyService(new ConfigService(env));

  it('routes instant, human-in-the-loop features to STANDARD', () => {
    const policy = make({ AI_BATCH_ENABLED: 'true' });
    for (const feature of [
      AI_FEATURE.BOOKING_CHAT,
      AI_FEATURE.WHATSAPP_CHAT,
      AI_FEATURE.LIVE_CHAT,
      AI_FEATURE.TOOL_CALL,
      AI_FEATURE.RAG_QUERY,
      AI_FEATURE.APPOINTMENT_MUTATION,
    ]) {
      expect(policy.resolveMode(feature).mode).toBe(AI_EXECUTION_MODE.STANDARD);
    }
  });

  it('routes bulk, non-interactive features to BATCH when batch is enabled', () => {
    const policy = make({ AI_BATCH_ENABLED: 'true' });
    for (const feature of [
      AI_FEATURE.REPORT,
      AI_FEATURE.ANALYTICS,
      AI_FEATURE.EVALUATION,
      AI_FEATURE.BULK_EMBEDDING,
      AI_FEATURE.FILE_INDEXING,
      AI_FEATURE.REINDEX,
    ]) {
      expect(policy.resolveMode(feature).mode).toBe(AI_EXECUTION_MODE.BATCH);
    }
  });

  it('falls back BATCH features to STANDARD when batch is disabled (default OFF)', () => {
    const policy = make(); // AI_BATCH_ENABLED unset → false
    const decision = policy.resolveMode(AI_FEATURE.REPORT);
    expect(decision.mode).toBe(AI_EXECUTION_MODE.STANDARD);
    expect(decision.reason).toBe('batch_disabled_fallback_standard');
    expect(policy.isBatchEnabled()).toBe(false);
  });

  it('derives the mode purely from the feature — there is no caller-supplied override', () => {
    // The signature only accepts a feature: a request body can never inject a mode.
    const policy = make({ AI_BATCH_ENABLED: 'true' });
    expect(policy.resolveMode(AI_FEATURE.BOOKING_CHAT).mode).toBe(AI_EXECUTION_MODE.STANDARD);
    expect(policy.resolveMode(AI_FEATURE.REPORT).mode).toBe(AI_EXECUTION_MODE.BATCH);
  });

  describe('shouldBatchEmbeddings', () => {
    it('is false whenever batch is disabled, regardless of size or force', () => {
      const policy = make({ AI_BATCH_EMBEDDING_CHUNK_THRESHOLD: 10 });
      expect(policy.shouldBatchEmbeddings(9999)).toBe(false);
      expect(policy.shouldBatchEmbeddings(9999, true)).toBe(false);
    });

    it('batches at/above the configured threshold when enabled', () => {
      const policy = make({ AI_BATCH_ENABLED: 'true', AI_BATCH_EMBEDDING_CHUNK_THRESHOLD: 200 });
      expect(policy.shouldBatchEmbeddings(199)).toBe(false);
      expect(policy.shouldBatchEmbeddings(200)).toBe(true);
      expect(policy.shouldBatchEmbeddings(1000)).toBe(true);
    });

    it('force-batches (re-index/bulk) below the threshold when enabled', () => {
      const policy = make({ AI_BATCH_ENABLED: 'true', AI_BATCH_EMBEDDING_CHUNK_THRESHOLD: 200 });
      expect(policy.shouldBatchEmbeddings(1, true)).toBe(true);
    });
  });
});
