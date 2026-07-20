import { ConfigService } from '@nestjs/config';

import { OpenAiBatchProvider } from './openai-batch.provider';
import {
  buildBatchJsonl,
  parseBatchResultsJsonl,
  extractEmbeddingVector,
  sumEmbeddingTokens,
  AiBatchLineRequest,
} from './ai-batch-provider.interface';
import { AI_BATCH_STATUS, mapOpenAiBatchStatus } from '../execution/ai-execution.constants';

describe('Batch JSONL helpers (pure, network-free)', () => {
  const requests: AiBatchLineRequest[] = [
    { customId: 'kb-1', method: 'POST', url: '/v1/embeddings', body: { model: 'm', input: 'a' } },
    { customId: 'kb-2', method: 'POST', url: '/v1/embeddings', body: { model: 'm', input: 'b' } },
  ];

  it('serializes one JSON object per line with custom_id/method/url/body', () => {
    const lines = buildBatchJsonl(requests).split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      custom_id: 'kb-1', method: 'POST', url: '/v1/embeddings', body: { model: 'm', input: 'a' },
    });
  });

  it('binds results by custom_id regardless of line ORDER (never positional)', () => {
    // Output file returns lines in the OPPOSITE order to the input.
    const jsonl = [
      JSON.stringify({ custom_id: 'kb-2', response: { status_code: 200, body: { data: [{ embedding: [0.2] }], usage: { total_tokens: 3 } } }, error: null }),
      JSON.stringify({ custom_id: 'kb-1', response: { status_code: 200, body: { data: [{ embedding: [0.1] }], usage: { total_tokens: 5 } } }, error: null }),
    ].join('\n');
    const parsed = parseBatchResultsJsonl(jsonl);
    const byId = new Map(parsed.map((r) => [r.customId, r]));
    expect(extractEmbeddingVector(byId.get('kb-1')!.body)).toEqual([0.1]);
    expect(extractEmbeddingVector(byId.get('kb-2')!.body)).toEqual([0.2]);
    expect(sumEmbeddingTokens(parsed)).toBe(8);
  });

  it('surfaces per-line errors (partial failure) and skips blank/garbage lines', () => {
    const jsonl = [
      '',
      JSON.stringify({ custom_id: 'kb-1', response: { status_code: 200, body: { data: [{ embedding: [0.1] }] } }, error: null }),
      '{ not json',
      JSON.stringify({ custom_id: 'kb-2', response: null, error: { code: 'rate_limit', message: 'slow down' } }),
      JSON.stringify({ custom_id: 'kb-3', response: { status_code: 500, body: {} }, error: null }),
    ].join('\n');
    const parsed = parseBatchResultsJsonl(jsonl);
    expect(parsed).toHaveLength(3);
    const byId = new Map(parsed.map((r) => [r.customId, r]));
    expect(byId.get('kb-1')!.error).toBeNull();
    expect(byId.get('kb-2')!.error?.code).toBe('rate_limit');
    // A 5xx with no explicit error object is still treated as a failure.
    expect(byId.get('kb-3')!.error?.code).toBe('HTTP_500');
  });

  it('maps every OpenAI batch status onto the local lifecycle', () => {
    expect(mapOpenAiBatchStatus('validating')).toBe(AI_BATCH_STATUS.SUBMITTED);
    expect(mapOpenAiBatchStatus('in_progress')).toBe(AI_BATCH_STATUS.IN_PROGRESS);
    expect(mapOpenAiBatchStatus('finalizing')).toBe(AI_BATCH_STATUS.FINALIZING);
    expect(mapOpenAiBatchStatus('completed')).toBe(AI_BATCH_STATUS.COMPLETED);
    expect(mapOpenAiBatchStatus('failed')).toBe(AI_BATCH_STATUS.FAILED);
    expect(mapOpenAiBatchStatus('expired')).toBe(AI_BATCH_STATUS.EXPIRED);
    expect(mapOpenAiBatchStatus('cancelled')).toBe(AI_BATCH_STATUS.CANCELLED);
    expect(mapOpenAiBatchStatus('weird-future-status')).toBe(AI_BATCH_STATUS.IN_PROGRESS);
  });
});

describe('OpenAiBatchProvider (mocked SDK — real Batch API surface)', () => {
  function setup() {
    const clients = { forTenant: jest.fn().mockResolvedValue(undefined) }; // no residency override
    const provider = new OpenAiBatchProvider(
      new ConfigService({ OPENAI_API_KEY: 'sk-test' }),
      clients as never,
    );
    const files = {
      create: jest.fn().mockResolvedValue({ id: 'file_in_1' }),
      content: jest.fn(),
    };
    const batches = {
      create: jest.fn().mockResolvedValue({
        id: 'batch_1', status: 'validating', input_file_id: 'file_in_1',
        request_counts: { total: 2, completed: 0, failed: 0 },
      }),
      retrieve: jest.fn(),
      cancel: jest.fn().mockResolvedValue({ id: 'batch_1', status: 'cancelling' }),
    };
    (provider as unknown as { client: unknown }).client = { files, batches };
    return { provider, files, batches, clients };
  }

  it('uploads a JSONL input file and creates a REAL batch (not a Standard-API loop)', async () => {
    const { provider, files, batches } = setup();
    const handle = await provider.submit({
      tenantId: 'tenant-1',
      endpoint: '/v1/embeddings',
      requests: [{ customId: 'kb-1', method: 'POST', url: '/v1/embeddings', body: { model: 'm', input: 'x' } }],
    });
    expect(files.create).toHaveBeenCalledTimes(1);
    expect(files.create.mock.calls[0][0].purpose).toBe('batch');
    expect(batches.create).toHaveBeenCalledWith(
      expect.objectContaining({ input_file_id: 'file_in_1', endpoint: '/v1/embeddings', completion_window: '24h' }),
    );
    expect(handle.externalId).toBe('batch_1');
    expect(handle.status).toBe(AI_BATCH_STATUS.SUBMITTED);
    expect(handle.counts.total).toBe(2);
  });

  it('polls and downloads output + error files, splitting success from failure', async () => {
    const { provider, files, batches } = setup();
    batches.retrieve.mockResolvedValue({
      id: 'batch_1', status: 'completed', input_file_id: 'file_in_1',
      output_file_id: 'file_out', error_file_id: 'file_err',
      request_counts: { total: 2, completed: 1, failed: 1 },
    });
    files.content
      .mockResolvedValueOnce({ text: async () => JSON.stringify({ custom_id: 'kb-1', response: { status_code: 200, body: { data: [{ embedding: [0.5] }], usage: { total_tokens: 4 } } }, error: null }) })
      .mockResolvedValueOnce({ text: async () => JSON.stringify({ custom_id: 'kb-2', response: null, error: { code: 'bad', message: 'nope' } }) });

    const handle = await provider.poll('tenant-1', 'batch_1');
    expect(handle.status).toBe(AI_BATCH_STATUS.COMPLETED);
    const { outputs, errors } = await provider.fetchResults('tenant-1', handle);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].customId).toBe('kb-1');
    expect(errors).toHaveLength(1);
    expect(errors[0].error?.code).toBe('bad');
  });

  it('uses the tenant residency client when one is enforced', async () => {
    const { provider, clients } = setup();
    const tenantFiles = { create: jest.fn().mockResolvedValue({ id: 'file_eu' }) };
    const tenantBatches = { create: jest.fn().mockResolvedValue({ id: 'batch_eu', status: 'validating', request_counts: { total: 1 } }) };
    clients.forTenant.mockResolvedValue({ files: tenantFiles, batches: tenantBatches });

    const handle = await provider.submit({
      tenantId: 'tenant-eu',
      endpoint: '/v1/embeddings',
      requests: [{ customId: 'kb-1', method: 'POST', url: '/v1/embeddings', body: {} }],
    });
    expect(tenantFiles.create).toHaveBeenCalledTimes(1);
    expect(handle.externalId).toBe('batch_eu');
  });
});
