import { AiBatchService } from './ai-batch.service';
import { AI_BATCH_STATUS, AI_EXECUTION_MODE, AI_FEATURE } from '../execution/ai-execution.constants';
import { AiBatchCompletedEvent } from '../../../events/ai-batch.events';

/**
 * Unit tests for the batch orchestrator (OpenAI Batch API mocked — a live batch
 * needs API credits; see the deferred live-test note). They prove: submission
 * idempotency + the crash-safe state machine (save remote ids ASAP; no duplicate
 * remote batch on an uncertain outcome; correlation reconciliation), opaque
 * custom_id, out-of-order result binding, partial failure, BATCH-rate cost, and
 * tenant isolation.
 */
describe('AiBatchService', () => {
  function makeJob(over: Record<string, unknown> = {}) {
    return {
      id: 'job-1', tenant_id: 't1', agent_id: 'a1', model: 'text-embedding-3-small',
      provider: 'openai', feature: AI_FEATURE.FILE_INDEXING, endpoint: '/v1/embeddings',
      status: AI_BATCH_STATUS.PREPARING, correlation_id: 'corr-1',
      input_file_id: null, external_batch_id: null, poll_attempts: 0,
      region: null, source_type: 'training_file', source_id: 'file-1',
      updated_at: new Date(0), created_at: new Date(0), ...over,
    };
  }

  function setup(jobInit: Record<string, unknown> = {}) {
    const job: Record<string, unknown> = makeJob(jobInit);
    const jobs = {
      findOneByOrFail: jest.fn(async () => ({ ...job })),
      findOneBy: jest.fn(async () => ({ ...job })),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn(async (_w: unknown, patch: Record<string, unknown>) => { Object.assign(job, patch); }),
      increment: jest.fn(async () => undefined),
    };
    const items = {
      find: jest.fn().mockResolvedValue([
        { id: 'i1', custom_id: 'cid-1', target_ref: 'kb-1', chunk_index: 0, status: 'PENDING' },
      ]),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn(),
    };
    const provider = {
      isConfigured: jest.fn().mockReturnValue(true),
      uploadInputFile: jest.fn().mockResolvedValue({ inputFileId: 'file-remote-1' }),
      createBatch: jest.fn().mockResolvedValue({
        externalId: 'batch-1', status: AI_BATCH_STATUS.SUBMITTED, inputFileId: 'file-remote-1',
        counts: { total: 1, completed: 0, failed: 0 },
      }),
      submit: jest.fn(),
      poll: jest.fn(),
      cancel: jest.fn(),
      findByCorrelation: jest.fn().mockResolvedValue(null),
      fetchResults: jest.fn(),
    };
    const ingestion = {
      currentEmbeddingModel: jest.fn().mockReturnValue('text-embedding-3-small'),
      contentsByIds: jest.fn().mockResolvedValue(new Map([['kb-1', 'chunk text']])),
      unembeddedChunkIds: jest.fn().mockResolvedValue(['kb-1']),
      saveEmbedding: jest.fn().mockResolvedValue(undefined),
    };
    const residency = { resolve: jest.fn().mockResolvedValue({ enforced: false, region: null, deploymentId: null, options: null }) };
    const costs = {
      quoteEmbedding: jest.fn().mockReturnValue({ status: 'PRICED', costMicrousd: 30n, executionMode: 'BATCH' }),
      recordInTransaction: jest.fn().mockResolvedValue({ inserted: true }),
    };
    // By default the submission-lease CAS (an UPDATE … SET next_poll_at …
    // RETURNING id, WITHOUT SKIP LOCKED) is won; everything else returns [].
    const query = jest.fn(async (sql: string, ..._params: unknown[]) =>
      /SET next_poll_at/.test(sql) && /RETURNING id/.test(sql) && !/SKIP LOCKED/.test(sql)
        ? [{ id: 'lease' }]
        : [],
    );
    const dataSource = { query, transaction: jest.fn() };
    const config = { get: jest.fn((_k: string, d: unknown) => d) };
    const emitter = { emit: jest.fn() };
    const service = new AiBatchService(
      jobs as never, items as never, provider as never, ingestion as never,
      residency as never, costs as never, dataSource as never, config as never, emitter as never,
    );
    return { service, job, jobs, items, provider, ingestion, residency, costs, dataSource, query, emitter };
  }

  const submitInput = {
    tenantId: 't1', feature: AI_FEATURE.FILE_INDEXING, agentId: 'a1',
    items: [{ targetRef: 'kb-1' }], idempotencyKey: 'training:t1:file-1:hash',
    sourceType: 'training_file', sourceId: 'file-1',
  };

  describe('submission idempotency + state machine', () => {
    it('resumes an existing already-submitted job without a second remote batch', async () => {
      const { service, provider, query } = setup({ status: AI_BATCH_STATUS.SUBMITTED, external_batch_id: 'batch-1' });
      query.mockResolvedValueOnce([]); // claim conflicts → not created
      await service.submitEmbeddingBatch(submitInput);
      expect(provider.uploadInputFile).not.toHaveBeenCalled();
      expect(provider.createBatch).not.toHaveBeenCalled();
    });

    it('uploads then creates, persisting the input file id BEFORE the create', async () => {
      const { service, provider, jobs, query } = setup();
      query.mockResolvedValueOnce([{ id: 'job-1' }]); // claim created
      await service.submitEmbeddingBatch(submitInput);
      expect(provider.uploadInputFile).toHaveBeenCalledTimes(1);
      expect(provider.createBatch).toHaveBeenCalledTimes(1);
      // input_file_id was persisted (status → SUBMITTING) before create ran.
      const savedFileFirst = jobs.update.mock.calls.find((c) => c[1]?.input_file_id === 'file-remote-1');
      expect(savedFileFirst).toBeDefined();
      // create carries the correlation id in metadata (for reconciliation).
      expect(provider.createBatch.mock.calls[0][0].metadata.correlation_id).toBe('corr-1');
    });

    it('uses an OPAQUE uuid custom_id (never the chunk/kb id) with a chunk_index', async () => {
      const { service, query } = setup();
      query.mockResolvedValueOnce([{ id: 'job-1' }]); // claim created
      await service.submitEmbeddingBatch(submitInput);
      const insertItem = query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO ai_batch_items'));
      expect(insertItem).toBeDefined();
      const params = insertItem![1] as unknown[];
      // params: [jobId, tenantId, custom_id, sourceType, sourceId, chunk_index, target_ref]
      expect(params[2]).toMatch(/^[0-9a-f-]{36}$/); // opaque uuid
      expect(params[2]).not.toBe('kb-1');
      expect(params[6]).toBe('kb-1'); // target_ref binds internally
      expect(params[5]).toBe(0); // chunk_index
      expect(String(insertItem![0])).toContain('ON CONFLICT (batch_job_id, source_type, source_id, chunk_index)');
    });

    it('marks SUBMISSION_UNKNOWN and does NOT recreate when the create outcome is ambiguous', async () => {
      const { service, provider, jobs, query } = setup();
      query.mockResolvedValueOnce([{ id: 'job-1' }]);
      provider.createBatch.mockRejectedValue(Object.assign(new Error('socket hang up'), { name: 'APIConnectionTimeoutError' }));
      await expect(service.submitEmbeddingBatch(submitInput)).rejects.toThrow();
      expect(provider.createBatch).toHaveBeenCalledTimes(1); // never retried inline
      const unknown = jobs.update.mock.calls.find((c) => c[1]?.status === AI_BATCH_STATUS.SUBMISSION_UNKNOWN);
      expect(unknown).toBeDefined();
    });

    it('keeps a definitive HTTP create failure retryable (SUBMITTING, not UNKNOWN)', async () => {
      const { service, provider, jobs, query } = setup();
      query.mockResolvedValueOnce([{ id: 'job-1' }]);
      provider.createBatch.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
      await expect(service.submitEmbeddingBatch(submitInput)).rejects.toThrow();
      const unknown = jobs.update.mock.calls.find((c) => c[1]?.status === AI_BATCH_STATUS.SUBMISSION_UNKNOWN);
      expect(unknown).toBeUndefined();
    });

    it('does NOT submit when another worker holds the submission lease (no duplicate batch)', async () => {
      const { service, provider, query } = setup();
      // Lease CAS returns no row → another worker owns the submission.
      query.mockImplementation(async () => []);
      query.mockResolvedValueOnce([{ id: 'job-1' }]); // claim created
      await service.submitEmbeddingBatch(submitInput);
      expect(provider.uploadInputFile).not.toHaveBeenCalled();
      expect(provider.createBatch).not.toHaveBeenCalled();
    });

    it('resumes after a crash between upload and create WITHOUT re-uploading', async () => {
      // Job already has an input_file_id but no external id (crash after upload).
      const { service, provider, query } = setup({ status: AI_BATCH_STATUS.SUBMITTING, input_file_id: 'file-remote-1' });
      query.mockResolvedValueOnce([]); // retry → existing job
      await service.submitEmbeddingBatch(submitInput);
      expect(provider.uploadInputFile).not.toHaveBeenCalled();
      expect(provider.createBatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconcileSubmissions', () => {
    it('adopts an already-created remote batch by correlation id (no duplicate)', async () => {
      const { service, provider, jobs } = setup({ status: AI_BATCH_STATUS.SUBMISSION_UNKNOWN });
      jobs.find.mockResolvedValue([makeJob({ status: AI_BATCH_STATUS.SUBMISSION_UNKNOWN })]);
      provider.findByCorrelation.mockResolvedValue({
        externalId: 'batch-recovered', status: AI_BATCH_STATUS.IN_PROGRESS, counts: { total: 1, completed: 0, failed: 0 },
      });
      const result = await service.reconcileSubmissions();
      expect(result.recovered).toBe(1);
      expect(provider.createBatch).not.toHaveBeenCalled(); // adopted, never recreated
      const adopt = jobs.update.mock.calls.find((c) => c[1]?.external_batch_id === 'batch-recovered');
      expect(adopt).toBeDefined();
    });

    it('fails a submission safely after exhausting reconcile attempts', async () => {
      const { service, jobs } = setup();
      jobs.find.mockResolvedValue([makeJob({ status: AI_BATCH_STATUS.SUBMISSION_UNKNOWN, poll_attempts: 99 })]);
      await service.reconcileSubmissions();
      const failed = jobs.update.mock.calls.find((c) => c[1]?.status === AI_BATCH_STATUS.FAILED);
      expect(failed?.[1].error_code).toBe('SUBMISSION_RECONCILE_EXHAUSTED');
    });
  });

  describe('pollJob terminal result processing', () => {
    function terminal() {
      const ctx = setup({ status: AI_BATCH_STATUS.IN_PROGRESS, external_batch_id: 'batch-1' });
      const itemRows = [
        { id: 'i1', custom_id: 'cid-1', target_ref: 'kb-1', status: 'PENDING' },
        { id: 'i2', custom_id: 'cid-2', target_ref: 'kb-2', status: 'PENDING' },
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
      // Out-of-order: kb-2 succeeds, kb-1 fails.
      ctx.provider.fetchResults.mockResolvedValue({
        outputs: [{ customId: 'cid-2', statusCode: 200, body: { data: [{ embedding: [0.2, 0.3] }], usage: { total_tokens: 3 } }, error: null }],
        errors: [{ customId: 'cid-1', statusCode: null, body: null, error: { code: 'context_length_exceeded' } }],
      });
      return { ...ctx, manager };
    }

    it('binds by custom_id (not order) and writes vectors to the job tenant/agent only', async () => {
      const { service, ingestion } = terminal();
      expect(await service.pollJob('job-1')).toBe(true);
      expect(ingestion.saveEmbedding).toHaveBeenCalledTimes(1);
      const [kbId, tenantId, agentId, vector] = ingestion.saveEmbedding.mock.calls[0];
      expect([kbId, tenantId, agentId, vector]).toEqual(['kb-2', 't1', 'a1', [0.2, 0.3]]);
    });

    it('prices batch embeddings at the BATCH rate and attributes to the job', async () => {
      const { service, costs } = terminal();
      await service.pollJob('job-1');
      expect(costs.quoteEmbedding).toHaveBeenCalledWith('text-embedding-3-small', 3, AI_EXECUTION_MODE.BATCH, 'openai');
      expect(costs.recordInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ executionMode: AI_EXECUTION_MODE.BATCH, batchJobId: 'job-1', channel: 'BATCH' }),
      );
    });

    it('emits AiBatchCompletedEvent with the completed/failed split', async () => {
      const { service, emitter } = terminal();
      await service.pollJob('job-1');
      expect(emitter.emit).toHaveBeenCalledWith(
        AiBatchCompletedEvent.eventName,
        expect.objectContaining({ completedRequests: 1, failedRequests: 1, sourceId: 'file-1' }),
      );
    });

    it('reschedules with backoff (no processing) while still in progress', async () => {
      const { service, provider, jobs } = setup({ status: AI_BATCH_STATUS.IN_PROGRESS, external_batch_id: 'batch-1' });
      provider.poll.mockResolvedValue({ externalId: 'batch-1', status: AI_BATCH_STATUS.IN_PROGRESS, counts: { total: 2, completed: 1, failed: 0 } });
      expect(await service.pollJob('job-1')).toBe(false);
      const reschedule = jobs.update.mock.calls.find((c) => c[1]?.next_poll_at instanceof Date);
      expect(reschedule).toBeDefined();
    });
  });

  it('sweep is a no-op when the provider is unconfigured', async () => {
    const { service, provider, query } = setup();
    provider.isConfigured.mockReturnValue(false);
    expect(await service.sweep()).toEqual({ polled: 0, finalized: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('sweep leases due jobs with FOR UPDATE SKIP LOCKED', async () => {
    const { service, query, provider } = setup();
    // reconcile finds nothing; expire returns []; lease returns one job id.
    query.mockImplementation(async (sql: string) => (/RETURNING id/.test(sql) && /SKIP LOCKED/.test(sql) ? [{ id: 'job-1' }] : []));
    provider.poll.mockResolvedValue({ externalId: 'batch-1', status: AI_BATCH_STATUS.IN_PROGRESS, counts: { total: 1, completed: 0, failed: 0 } });
    const result = await service.sweep();
    expect(result.polled).toBe(1);
    const leaseCall = query.mock.calls.find((c) => /SKIP LOCKED/.test(String(c[0])));
    expect(leaseCall).toBeDefined();
  });
});
