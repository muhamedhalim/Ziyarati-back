import { ConfigService } from '@nestjs/config';
import { AiTrainingFileService } from './ai-training-file.service';
import { TRAINING_FILE_STATUS } from './ai.constants';

describe('AiTrainingFileService physical indexing', () => {
  function setup(fileType = 'TXT') {
    const file: any = {
      id: 'file-1', file_name: `faq.${fileType.toLowerCase()}`,
      file_url: 'tenant-1/ai_training/faq.txt', file_type: fileType,
      status: TRAINING_FILE_STATUS.PENDING, attempts: 0,
      agent: { id: 'agent-1' },
    };
    const statuses: string[] = [];
    const files = {
      findOne: jest.fn().mockResolvedValue(file),
      save: jest.fn(async (value: any) => { statuses.push(value.status); return value; }),
      create: jest.fn((v) => v), findAndCount: jest.fn(), remove: jest.fn(),
    };
    const ingestion = {
      ingestDocument: jest.fn().mockResolvedValue({ chunks: 2, embedded: 2, deduplicated: 0 }),
      cleanupSource: jest.fn().mockResolvedValue(undefined),
    };
    const storage = { downloadObject: jest.fn().mockResolvedValue(Buffer.from('Arabic العربية\nEnglish FAQ')) };
    // Batch OFF + small file → the policy resolves to the synchronous STANDARD path.
    const batch = { isConfigured: jest.fn().mockReturnValue(false) };
    const policy = {
      resolveEmbeddingExecution: jest.fn().mockReturnValue({ mode: 'STANDARD', action: 'RUN', reason: 'test' }),
    };
    const batchJobs = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new AiTrainingFileService(
      files as any, { exists: jest.fn().mockResolvedValue(true) } as any,
      batchJobs as any, ingestion as any, batch as any, policy as any, storage as any,
      new ConfigService({ AI_TRAINING_FILE_MAX_BYTES: 1024 }),
    );
    return { service, file, files, statuses, ingestion, storage };
  }

  it('does not become INDEXED until fetch, extraction, chunking, embedding, and persistence complete', async () => {
    const { service, statuses, ingestion } = setup();
    let resolve!: (value: { chunks: number; embedded: number; deduplicated: number }) => void;
    ingestion.ingestDocument.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const processing = service.process('tenant-1', 'file-1');
    await new Promise((r) => setImmediate(r));
    expect(statuses).toEqual([TRAINING_FILE_STATUS.PROCESSING]);
    resolve({ chunks: 1, embedded: 1, deduplicated: 0 });
    const result = await processing;
    expect(result.status).toBe(TRAINING_FILE_STATUS.INDEXED);
    expect(statuses).toEqual([TRAINING_FILE_STATUS.PROCESSING, TRAINING_FILE_STATUS.INDEXED]);
  });

  it('cleans partial chunks and records a safe FAILED status when indexing fails', async () => {
    const { service, file, ingestion, statuses } = setup();
    ingestion.ingestDocument.mockRejectedValueOnce(new Error('provider secret detail'));
    await expect(service.process('tenant-1', 'file-1')).rejects.toThrow('Training file indexing failed.');
    expect(ingestion.cleanupSource).toHaveBeenCalledWith('tenant-1', 'file-1');
    expect(file.error_code).toBe('INDEXING_FAILED');
    expect(statuses.at(-1)).toBe(TRAINING_FILE_STATUS.FAILED);
  });

  it('fails unsupported extractor types honestly instead of reporting false success', async () => {
    const { service, storage, ingestion, file } = setup('PDF');
    await expect(service.process('tenant-1', 'file-1')).rejects.toThrow('No text extractor is configured for PDF.');
    expect(storage.downloadObject).not.toHaveBeenCalled();
    expect(ingestion.ingestDocument).not.toHaveBeenCalled();
    expect(file.status).toBe(TRAINING_FILE_STATUS.FAILED);
  });
});
