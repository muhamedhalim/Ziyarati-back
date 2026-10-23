import { ConfigService } from '@nestjs/config';
import { AiTrainingFileService } from './ai-training-file.service';
import { TRAINING_FILE_STATUS } from './ai.constants';

describe('AiTrainingFileService physical indexing', () => {
  function setup(fileType = 'TXT', hasAgent = true) {
    const file: any = {
      id: 'file-1',
      file_name: `faq.${fileType.toLowerCase()}`,
      file_url: 'tenant-1/ai_training/faq.txt',
      file_type: fileType,
      status: TRAINING_FILE_STATUS.PENDING,
      attempts: 0,
      agent: hasAgent ? { id: 'agent-1' } : undefined,
    };
    const statuses: string[] = [];
    const files = {
      findOne: jest.fn().mockResolvedValue(file),
      save: jest.fn(async (value: any) => {
        statuses.push(value.status);
        return value;
      }),
      create: jest.fn((v) => v),
      findAndCount: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ bytes: '0' }),
      })),
    };
    const ingestion = {
      ingestDocument: jest
        .fn()
        .mockResolvedValue({ chunks: 2, embedded: 2, deduplicated: 0 }),
      cleanupSource: jest.fn().mockResolvedValue(undefined),
    };
    const storage = {
      downloadObject: jest
        .fn()
        .mockResolvedValue(Buffer.from('Arabic العربية\nEnglish FAQ')),
      assertKeyBelongsToTenant: jest.fn(),
      assertKeyInDocType: jest.fn(),
    };
    // Batch OFF + small file → the policy resolves to the synchronous STANDARD path.
    const batch = { isConfigured: jest.fn().mockReturnValue(false) };
    const policy = {
      resolveEmbeddingExecution: jest
        .fn()
        .mockReturnValue({ mode: 'STANDARD', action: 'RUN', reason: 'test' }),
    };
    const batchJobs = { findOne: jest.fn().mockResolvedValue(null) };
    // No agent is provisioned for the tenant by default — `upload()`'s default
    // resolution (`resolveDefaultAgentId`) must tolerate that (returns null).
    const agents = {
      exists: jest.fn().mockResolvedValue(true),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const service = new AiTrainingFileService(
      files as any,
      agents as any,
      batchJobs as any,
      ingestion as any,
      batch as any,
      policy as any,
      storage as any,
      new ConfigService({ AI_TRAINING_FILE_MAX_BYTES: 1024 }),
      // `max_training_files` is a real plan cap on a deliberate upload, checked
      // on both upload entry points. These tests exercise the INDEXING
      // lifecycle, so the cap is a satisfied no-op here.
      {
        assertResourceWithinLimit: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    return { service, file, files, statuses, ingestion, storage, agents };
  }

  it('does not become INDEXED until fetch, extraction, chunking, embedding, and persistence complete', async () => {
    const { service, statuses, ingestion } = setup();
    let resolve!: (value: {
      chunks: number;
      embedded: number;
      deduplicated: number;
    }) => void;
    ingestion.ingestDocument.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const processing = service.process('tenant-1', 'file-1');
    await new Promise((r) => setImmediate(r));
    expect(statuses).toEqual([TRAINING_FILE_STATUS.PROCESSING]);
    resolve({ chunks: 1, embedded: 1, deduplicated: 0 });
    const result = await processing;
    expect(result.status).toBe(TRAINING_FILE_STATUS.INDEXED);
    expect(statuses).toEqual([
      TRAINING_FILE_STATUS.PROCESSING,
      TRAINING_FILE_STATUS.INDEXED,
    ]);
  });

  it('cleans partial chunks and records a safe FAILED status when indexing fails', async () => {
    const { service, file, ingestion, statuses } = setup();
    ingestion.ingestDocument.mockRejectedValueOnce(
      new Error('provider secret detail'),
    );
    await expect(service.process('tenant-1', 'file-1')).rejects.toThrow(
      'Training file indexing failed.',
    );
    expect(ingestion.cleanupSource).toHaveBeenCalledWith('tenant-1', 'file-1');
    expect(file.error_code).toBe('INDEXING_FAILED');
    expect(statuses.at(-1)).toBe(TRAINING_FILE_STATUS.FAILED);
  });

  it('uploads (registers) a training file with no agentId and no tenant agent to resolve — never blocked', async () => {
    const { service, files } = setup();

    const uploaded = await service.upload('tenant-1', {
      fileName: 'faq.txt',
      fileUrl: 'tenant-1/ai_training/faq.txt',
      fileType: 'TXT',
      fileSize: 100,
    } as any);

    expect(files.save).toHaveBeenCalled();
    expect(uploaded.agent).toBeUndefined();
    expect(uploaded.status).toBe(TRAINING_FILE_STATUS.PENDING);
  });

  it('registers a training file only for a key bound to the ai_training docType (CR-40)', async () => {
    const { service, files, storage } = setup();
    storage.assertKeyInDocType.mockImplementationOnce(() => {
      throw new Error('Storage key is not a ai_training upload.');
    });

    await expect(
      service.upload('tenant-1', {
        fileName: 'scan.txt',
        fileUrl: 'tenant-1/customer_files/patient-scan.pdf',
        fileType: 'TXT',
        fileSize: 100,
      } as any),
    ).rejects.toThrow('not a ai_training upload');
    expect(storage.assertKeyInDocType).toHaveBeenCalledWith(
      'tenant-1/customer_files/patient-scan.pdf',
      'tenant-1',
      'ai_training',
    );
    expect(files.save).not.toHaveBeenCalled();
  });

  it('indexes a file with no agent (uploaded before the Admin provisioned one) — never blocked by AGENT_REQUIRED', async () => {
    const { service, statuses, ingestion } = setup('TXT', false);
    const result = await service.process('tenant-1', 'file-1');
    expect(result.status).toBe(TRAINING_FILE_STATUS.INDEXED);
    expect(statuses).not.toContain(TRAINING_FILE_STATUS.FAILED);
    expect(ingestion.ingestDocument).toHaveBeenCalledWith(
      'tenant-1',
      null,
      expect.any(String),
      'file-1',
      { requireEmbedding: true },
    );
  });

  it('fails unsupported extractor types honestly instead of reporting false success', async () => {
    const { service, storage, ingestion, file } = setup('PDF');
    await expect(service.process('tenant-1', 'file-1')).rejects.toThrow(
      'No text extractor is configured for PDF.',
    );
    expect(storage.downloadObject).not.toHaveBeenCalled();
    expect(ingestion.ingestDocument).not.toHaveBeenCalled();
    expect(file.status).toBe(TRAINING_FILE_STATUS.FAILED);
  });

  // AI-012 (T129, T132a, R13): the caller stays pgvector-unaware — it is the
  // ONE thing this test pins, so a regression that pushes vector-availability
  // knowledge up into the caller is caught here rather than only by manual
  // inspection.
  describe('remove() stays unaware of any pgvector dependency (T129)', () => {
    it('unconditionally delegates cleanup to ingestion.cleanupSource — never checks vector availability itself', async () => {
      const { service, file, files, ingestion, storage } = setup();
      (storage as { deleteObject?: jest.Mock }).deleteObject = jest
        .fn()
        .mockResolvedValue(undefined);

      await service.remove('tenant-1', 'file-1');

      expect(ingestion.cleanupSource).toHaveBeenCalledWith('tenant-1', 'file-1');
      expect(files.remove).toHaveBeenCalledWith(file);
    });

    it('still removes the knowledge-file row even though cleanupSource is a black box to this caller (may or may not touch a vector sidecar internally)', async () => {
      const { service, files, ingestion, storage } = setup();
      (storage as { deleteObject?: jest.Mock }).deleteObject = jest
        .fn()
        .mockResolvedValue(undefined);
      // Simulates a non-vector deployment where cleanupSource's OWN guard
      // (T128) skips the sidecar delete — remove() neither knows nor cares.
      ingestion.cleanupSource.mockResolvedValueOnce(undefined);

      await service.remove('tenant-1', 'file-1');

      expect(files.remove).toHaveBeenCalled();
    });
  });
});
