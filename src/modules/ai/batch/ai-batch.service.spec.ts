import { AiBatchService } from './ai-batch.service';
import { AI_BATCH_STATUS, AI_EXECUTION_MODE, AI_FEATURE } from '../execution/ai-execution.constants';
import { AiBatchCompletedEvent } from '../../../events/ai-batch.events';

/**
 * Unit tests for the batch orchestrator. The OpenAI Batch API itself is mocked
 * (a real end-to-end batch requires API credits — see the docs "deferred live
 * tests" note); these prove idempotency, custom_id binding, partial-failure
 * handling, BATCH-rate cost separation and tenant isolation.
 */
describe('AiBatchService', () => {
  const baseJob = {
    id: 'job-1', tenant_id: 't1', agent_id: 'a1', model: 'text-embedding-3-small',
    provider: 'openai', feature: AI_FEATURE.FILE_INDEXING, status: AI_BATCH_STATUS.IN_PROGRESS,
    external_batch_id: 'batch-1', region: null, source_type: 'training_file', source_id: 'file-1',
  };

  function setup(overrides: Partial<Record<string, unknown>> = {}) {
    const jobs = {
      findOneByOrFail: jest.fn().mockResolvedValue({ ...baseJob }),
      findOneBy: jest.fn().mockResolvedValue({ ...baseJob }),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const items = {};
    const provider = {
      isConfigured: jest.fn().mockReturnValue(true),
      submit: jest.fn(),
      poll: jest.fn(),
      cancel: jest.fn(),
      fetchResults: jest.fn(),
    };
    const ingestion = {
      currentEmbeddingModel: jest.fn().mockReturnValue('text-embedding-3-small'),
      saveEmbedding: jest.fn().mockResolvedValue(undefined),
    };
    const residency = { resolve: jest.fn().mockResolvedValue({ enforced: false, region: null, deploymentId: null, options: null }) };
    const policy = {};
    const costs = {
      quoteEmbedding: jest.fn().mockReturnValue({ status: 'PRICED', costMicrousd: 30n, executionMode: 'BATCH' }),
      recordInTransaction: jest.fn().mockResolvedValue({ inserted: true }),
    };
    const query = jest.fn().mockResolvedValue([]);
    const dataSource = {
      query,
      transaction: jest.fn(),
    };
    const config = { get: jest.fn((k: string, d: unknown) => d) };
    const emitter = { emit: jest.fn() };
    const service = new AiBatchService(
      jobs as never, items as never, provider as never, ingestion as never,
      residency as never, policy as never, costs as never, dataSource as never,
      config as never, emitter as never,
    );
    return { service, jobs, provider, ingestion, residency, costs, dataSource, query, emitter, ...overrides };
  }

  describe('submitEmbeddingBatch — idempotency', () => {
    it('reuses an existing job and never creates a second remote batch on retry', async () => {
      const { service, provider, query } = setup();
      query.mockResolvedValueOnce([]); // claim INSERT hit the unique conflict → not created
      const job = await service.submitEmbeddingBatch({
        tenantId: 't1', feature: AI_FEATURE.FILE_INDEXING, agentId: 'a1',
        items: [{ content: 'x', targetRef: 'kb-1' }], idempotencyKey: 'training:t1:file-1:hash',
      });
      expect(job).toBeDefined();
      expect(provider.submit).not.toHaveBeenCalled();
    });

    it('submits once and binds each request to its chunk by custom_id', async () => {
      const { service, provider, query } = setup();
      query.mockResolvedValueOnce([{ id: 'job-1' }]); // claim created
      provider.submit.mockResolvedValue({
        externalId: 'batch-1', status: AI_BATCH_STATUS.SUBMITTED, inputFileId: 'f1',
        counts: { total: 2, completed: 0, failed: 0 },
      });
      await service.submitEmbeddingBatch({
        tenantId: 't1', feature: AI_FEATURE.FILE_INDEXING, agentId: 'a1',
        items: [
          { content: 'first', targetRef: 'kb-1' },
          { content: 'second', targetRef: 'kb-2' },
        ],
        idempotencyKey: 'training:t1:file-1:hash',
      });
      expect(provider.submit).toHaveBeenCalledTimes(1);
      const submitted = provider.submit.mock.calls[0][0];
      expect(submitted.requests).toEqual([
        { customId: 'kb-1', method: 'POST', url: '/v1/embeddings', body: { model: 'text-embedding-3-small', input: 'first' } },
        { customId: 'kb-2', method: 'POST', url: '/v1/embeddings', body: { model: 'text-embedding-3-small', input: 'second' } },
      ]);
    });

    it('short-circuits an empty item list to COMPLETED without a remote batch', async () => {
      const { service, provider, jobs, query } = setup();
      query.mockResolvedValueOnce([{ id: 'job-1' }]);
      await service.submitEmbeddingBatch({
        tenantId: 't1', feature: AI_FEATURE.FILE_INDEXING, agentId: 'a1',
        items: [], idempotencyKey: 'k',
      });
      expect(provider.submit).not.toHaveBeenCalled();
      expect(jobs.update).toHaveBeenCalledWith(
        { id: 'job-1' },
        expect.objectContaining({ status: AI_BATCH_STATUS.COMPLETED, total_requests: 0 }),
      );
    });
  });

  describe('pollJob — terminal result processing', () => {
    function terminalSetup() {
      const ctx = setup();
      // Item rows keyed by custom_id; both start PENDING.
      const itemRows = [
        { id: 'i1', custom_id: 'kb-1', target_ref: 'kb-1', status: 'PENDING' },
        { id: 'i2', custom_id: 'kb-2', target_ref: 'kb-2', status: 'PENDING' },
      ];
      const managerQuery = jest.fn(async (sql: string) => {
        if (/FOR UPDATE/.test(sql)) return [{ status: 'IN_PROGRESS' }];
        if (/count\(\*\)/.test(sql)) return [{ completed: 1, failed: 1 }];
        return [];
      });
      const manager = { query: managerQuery, getRepository: jest.fn().mockReturnValue({ find: jest.fn().mockResolvedValue(itemRows) }) };
      ctx.dataSource.transaction.mockImplementation((fn: (m: unknown) => unknown) => fn(manager));

      ctx.provider.poll.mockResolvedValue({
        externalId: 'batch-1', status: AI_BATCH_STATUS.COMPLETED,
        outputFileId: 'out', errorFileId: 'err', counts: { total: 2, completed: 1, failed: 1 },
      });
      // Results returned OUT OF ORDER: kb-2 succeeds, kb-1 fails.
      ctx.provider.fetchResults.mockResolvedValue({
        outputs: [{ customId: 'kb-2', statusCode: 200, body: { data: [{ embedding: [0.2, 0.3] }], usage: { total_tokens: 3 } }, error: null }],
        errors: [{ customId: 'kb-1', statusCode: null, body: null, error: { code: 'context_length_exceeded' } }],
      });
      return { ...ctx, manager, managerQuery };
    }

    it('binds results by custom_id (not order), writes vectors to the owning tenant/agent', async () => {
      const { service, ingestion } = terminalSetup();
      const finalized = await service.pollJob('job-1');
      expect(finalized).toBe(true);
      // Only kb-2 succeeded — its vector is written to job.tenant/agent (isolation).
      expect(ingestion.saveEmbedding).toHaveBeenCalledTimes(1);
      const [kbId, tenantId, agentId, vector] = ingestion.saveEmbedding.mock.calls[0];
      expect(kbId).toBe('kb-2');
      expect(tenantId).toBe('t1');
      expect(agentId).toBe('a1');
      expect(vector).toEqual([0.2, 0.3]);
    });

    it('prices the batch embeddings at the BATCH rate (never the standard rate)', async () => {
      const { service, costs } = terminalSetup();
      await service.pollJob('job-1');
      expect(costs.quoteEmbedding).toHaveBeenCalledWith('text-embedding-3-small', 3, AI_EXECUTION_MODE.BATCH, 'openai');
      expect(costs.recordInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          executionMode: AI_EXECUTION_MODE.BATCH,
          requestKind: 'EMBEDDING',
          embeddingTokens: 3,
          batchJobId: 'job-1',
          channel: 'BATCH',
        }),
      );
    });

    it('emits AiBatchCompletedEvent with the completed/failed split (partial failure)', async () => {
      const { service, emitter } = terminalSetup();
      await service.pollJob('job-1');
      expect(emitter.emit).toHaveBeenCalledWith(
        AiBatchCompletedEvent.eventName,
        expect.objectContaining({
          tenantId: 't1', batchJobId: 'job-1', feature: AI_FEATURE.FILE_INDEXING,
          status: AI_BATCH_STATUS.COMPLETED, completedRequests: 1, failedRequests: 1,
          sourceType: 'training_file', sourceId: 'file-1',
        }),
      );
    });

    it('is a no-op when the job was already finalized by a concurrent poll', async () => {
      const ctx = terminalSetup();
      // The row lock reports an already-terminal status.
      ctx.manager.query.mockImplementation(async (sql: string) =>
        /FOR UPDATE/.test(sql) ? [{ status: AI_BATCH_STATUS.COMPLETED }] : [],
      );
      await ctx.service.pollJob('job-1');
      expect(ctx.ingestion.saveEmbedding).not.toHaveBeenCalled();
      expect(ctx.emitter.emit).not.toHaveBeenCalled();
    });

    it('keeps polling (no processing) while the batch is still in progress', async () => {
      const { service, provider, jobs } = setup();
      provider.poll.mockResolvedValue({
        externalId: 'batch-1', status: AI_BATCH_STATUS.IN_PROGRESS,
        counts: { total: 2, completed: 1, failed: 0 },
      });
      const finalized = await service.pollJob('job-1');
      expect(finalized).toBe(false);
      expect(provider.fetchResults).not.toHaveBeenCalled();
      expect(jobs.update).toHaveBeenCalledWith({ id: 'job-1' }, expect.objectContaining({ status: AI_BATCH_STATUS.IN_PROGRESS }));
    });
  });

  it('sweep is a no-op when the batch provider is unconfigured', async () => {
    const { service, provider, jobs } = setup();
    provider.isConfigured.mockReturnValue(false);
    const result = await service.sweep();
    expect(result).toEqual({ polled: 0, finalized: 0 });
    expect(jobs.find).not.toHaveBeenCalled();
  });
});
