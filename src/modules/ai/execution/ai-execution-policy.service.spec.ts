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

  describe('resolveEmbeddingExecution — batch-disabled behavior per feature', () => {
    it('runs BATCH at/above threshold and STANDARD below it when enabled', () => {
      const policy = make({ AI_BATCH_ENABLED: 'true', AI_BATCH_EMBEDDING_CHUNK_THRESHOLD: 200 });
      expect(policy.resolveEmbeddingExecution(AI_FEATURE.FILE_INDEXING, 500)).toMatchObject({ mode: AI_EXECUTION_MODE.BATCH, action: 'RUN' });
      expect(policy.resolveEmbeddingExecution(AI_FEATURE.FILE_INDEXING, 10)).toMatchObject({ mode: AI_EXECUTION_MODE.STANDARD, action: 'RUN' });
    });

    it('USE_STANDARD_IF_SMALL: small file runs STANDARD, large file FAILS (no huge sync job)', () => {
      const policy = make({ AI_STANDARD_MAX_EMBED_CHUNKS: 100 }); // batch disabled
      expect(policy.resolveEmbeddingExecution(AI_FEATURE.FILE_INDEXING, 50)).toMatchObject({ mode: AI_EXECUTION_MODE.STANDARD, action: 'RUN' });
      const big = policy.resolveEmbeddingExecution(AI_FEATURE.FILE_INDEXING, 5000);
      expect(big.action).toBe('FAIL');
      expect(big.reason).toBe('batch_disabled_too_large_for_standard');
    });

    it('DEFER features (bulk embeddings / re-index) never convert to STANDARD when disabled', () => {
      const policy = make({ AI_STANDARD_MAX_EMBED_CHUNKS: 100000 }); // even "small" must not convert
      expect(policy.resolveEmbeddingExecution(AI_FEATURE.BULK_EMBEDDING, 5).action).toBe('DEFER');
      expect(policy.resolveEmbeddingExecution(AI_FEATURE.REINDEX, 5).action).toBe('DEFER');
    });

    it('small reports/analytics may run STANDARD when below the safe size limit', () => {
      const policy = make({ AI_STANDARD_MAX_EMBED_CHUNKS: 100 });
      expect(policy.resolveEmbeddingExecution(AI_FEATURE.REPORT, 20)).toMatchObject({ mode: AI_EXECUTION_MODE.STANDARD, action: 'RUN' });
      expect(policy.resolveEmbeddingExecution(AI_FEATURE.ANALYTICS, 5000).action).toBe('FAIL');
    });
  });
});
