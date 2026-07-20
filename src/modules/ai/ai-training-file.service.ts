import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';

import { AiTrainingFile } from '../../entities/AI Agent/AiTrainingFile';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { UploadTrainingFileDto } from './dto/upload-training-file.dto';
import { UpdateTrainingFileDto } from './dto/update-training-file.dto';
import { TrainingFileFilterDto } from './dto/training-file-filter.dto';
import { TRAINING_FILE_STATUS } from './ai.constants';
import { AiKnowledgeIngestionService } from './ingestion/ai-knowledge-ingestion.service';
import { splitIntoChunks } from './ingestion/text-splitter';
import { AiBatchService } from './batch/ai-batch.service';
import { AiExecutionPolicyService } from './execution/ai-execution-policy.service';
import { AI_BATCH_STATUS, AI_FEATURE } from './execution/ai-execution.constants';
import { AiBatchCompletedEvent } from '../../events/ai-batch.events';
import { StorageService } from '../storage/storage.service';
import { AI_TRAINING_UPLOAD_POLICY } from '../storage/storage.constants';

/**
 * AI training files and their physical private-storage indexing lifecycle.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; the agent is
 * validated against the tenant. INDEXED is written only after private fetch,
 * UTF-8 extraction, chunking, embedding, and transactional persistence succeed.
 */
@Injectable()
export class AiTrainingFileService {
  private readonly logger = new Logger(AiTrainingFileService.name);

  constructor(
    @InjectRepository(AiTrainingFile)
    private readonly files: Repository<AiTrainingFile>,
    @InjectRepository(AiAgent) private readonly agents: Repository<AiAgent>,
    private readonly ingestion: AiKnowledgeIngestionService,
    private readonly batch: AiBatchService,
    private readonly policy: AiExecutionPolicyService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  async upload(tenantId: string, dto: UploadTrainingFileDto): Promise<AiTrainingFile> {
    if (dto.agentId) await this.assertAgent(tenantId, dto.agentId);
    this.storage.assertKeyBelongsToTenant(dto.fileUrl, tenantId);
    const file = this.files.create({
      tenant: { id: tenantId } as Tenant,
      agent: dto.agentId ? ({ id: dto.agentId } as AiAgent) : undefined,
      file_name: dto.fileName,
      file_url: dto.fileUrl,
      file_type: dto.fileType,
      status: TRAINING_FILE_STATUS.PENDING,
    });
    return this.files.save(file);
  }

  async uploadContent(
    tenantId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    agentId?: string,
  ): Promise<AiTrainingFile> {
    if (agentId) await this.assertAgent(tenantId, agentId);
    const maxBytes = Number(this.config.get('AI_TRAINING_FILE_MAX_BYTES', 10 * 1024 * 1024));
    if (!file.buffer?.length || file.size > maxBytes || file.buffer.length > maxBytes) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: 'Training file is empty or exceeds the indexing size limit.' });
    }
    const stored = await this.storage.upload({
      tenantId, docType: 'ai_training', originalName: file.originalname,
      mimeType: file.mimetype, size: file.size, buffer: file.buffer,
    }, AI_TRAINING_UPLOAD_POLICY);
    return this.upload(tenantId, {
      fileName: stored.filename,
      fileUrl: stored.storageKey,
      fileType: file.mimetype === 'text/markdown' ? 'MD' : 'TXT',
      agentId,
    });
  }

  async findAll(tenantId: string, filter: TrainingFileFilterDto) {
    const where: FindOptionsWhere<AiTrainingFile> = { tenant: { id: tenantId } };
    if (filter.agentId) where.agent = { id: filter.agentId };
    if (filter.status) where.status = filter.status;

    const [data, total] = await this.files.findAndCount({
      where,
      relations: { agent: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<AiTrainingFile> {
    const file = await this.files.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { agent: true },
    });
    if (!file) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Training file not found' });
    return file;
  }

  async update(tenantId: string, id: string, dto: UpdateTrainingFileDto): Promise<AiTrainingFile> {
    const file = await this.findOne(tenantId, id);
    if (dto.fileName !== undefined) file.file_name = dto.fileName;
    return this.files.save(file);
  }

  /** Physical PENDING/FAILED → PROCESSING → INDEXED/FAILED transition. */
  async process(tenantId: string, id: string): Promise<AiTrainingFile> {
    const file = await this.findOne(tenantId, id);
    if (file.status === TRAINING_FILE_STATUS.PROCESSING) {
      throw new AppError(ErrorCode.CONFLICT, { message: 'Training file is already processing' });
    }
    if (file.status === TRAINING_FILE_STATUS.INDEXED) return file;
    if (!file.agent?.id) return this.fail(file, 'AGENT_REQUIRED', 'An AI agent is required before indexing.');

    file.status = TRAINING_FILE_STATUS.PROCESSING;
    file.error_code = undefined;
    file.processing_started_at = new Date();
    file.indexed_at = undefined;
    file.attempts = (file.attempts ?? 0) + 1;
    await this.files.save(file);

    try {
      const type = this.detectType(file);
      if (!['TXT', 'MD'].includes(type)) {
        return this.fail(file, 'UNSUPPORTED_EXTRACTOR', `No text extractor is configured for ${type}.`);
      }
      if (/^https?:\/\//i.test(file.file_url)) {
        return this.fail(file, 'EXTERNAL_URL_REJECTED', 'Training files must use a tenant-owned private storage key.');
      }
      const maxBytes = Number(this.config.get('AI_TRAINING_FILE_MAX_BYTES', 10 * 1024 * 1024));
      const buffer = await this.storage.downloadObject(file.file_url, tenantId, maxBytes);
      const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
      if (!text || text.includes('\uFFFD')) {
        return this.fail(file, 'TEXT_EXTRACTION_FAILED', 'The file is empty or is not valid UTF-8 text.');
      }
      const contentHash = createHash('sha256').update(text.normalize('NFKC')).digest('hex');

      // Large files go through the async BATCH embedding route (cheaper, no
      // synchronous OpenAI round-trips) when it is enabled; small files stay on
      // the synchronous STANDARD route. The threshold is env-configurable.
      const chunkCount = splitIntoChunks(text, { maxTokens: 500, overlapTokens: 60 }).length;
      const useBatch = this.batch.isConfigured()
        && this.ingestion.canStoreEmbeddings()
        && this.policy.shouldBatchEmbeddings(chunkCount);

      if (useBatch) {
        const prepared = await this.ingestion.prepareBatchDocument(tenantId, file.agent.id, text, file.id);
        if (prepared.chunks <= 0) {
          return this.fail(file, 'NO_INDEXABLE_CONTENT', 'The file did not contain indexable text.');
        }
        file.content_hash = contentHash;
        file.chunk_count = prepared.chunks;
        if (prepared.pending.length === 0) {
          // Every chunk reused an existing vector — nothing to embed; index now.
          file.status = TRAINING_FILE_STATUS.INDEXED;
          file.error_code = undefined;
          file.indexed_at = new Date();
          return this.files.save(file);
        }
        await this.batch.submitEmbeddingBatch({
          tenantId,
          feature: AI_FEATURE.FILE_INDEXING,
          agentId: file.agent.id,
          items: prepared.pending.map((p) => ({ content: p.content, targetRef: p.kbId })),
          idempotencyKey: `training:${tenantId}:${file.id}:${contentHash}`,
          sourceType: 'training_file',
          sourceId: file.id,
        });
        // Stay PROCESSING: onBatchCompleted flips to INDEXED only after EVERY
        // embedding has been saved. The file is never marked INDEXED early.
        return this.files.save(file);
      }

      const result = await this.ingestion.ingestDocument(tenantId, file.agent.id, text, file.id, { requireEmbedding: true });
      if (result.chunks + result.deduplicated <= 0) {
        return this.fail(file, 'NO_INDEXABLE_CONTENT', 'The file did not contain indexable text.');
      }
      file.status = TRAINING_FILE_STATUS.INDEXED;
      file.error_code = undefined;
      file.chunk_count = result.chunks + result.deduplicated;
      file.content_hash = contentHash;
      file.indexed_at = new Date();
      return this.files.save(file);
    } catch (err) {
      if (err instanceof AppError && file.status === TRAINING_FILE_STATUS.FAILED) throw err;
      await this.ingestion.cleanupSource(tenantId, file.id).catch(() => undefined);
      const code = (err as Error).message === 'AI_EMBEDDING_UNAVAILABLE'
        ? 'EMBEDDING_UNAVAILABLE'
        : (err as Error).message === 'AI_EMBEDDING_INCOMPLETE'
          ? 'EMBEDDING_INCOMPLETE'
          : 'INDEXING_FAILED';
      this.logger.warn(`Training indexing failed tenant=${tenantId} file=${file.id} code=${code}`);
      return this.fail(file, code, 'Training file indexing failed.');
    }
  }

  /** Reprocess a FAILED file (architecture seam). */
  async reprocess(tenantId: string, id: string): Promise<AiTrainingFile> {
    const file = await this.findOne(tenantId, id);
    if (file.status !== TRAINING_FILE_STATUS.FAILED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only failed files can be reprocessed (current: "${file.status}")`,
      });
    }
    return this.process(tenantId, id);
  }

  /**
   * Finalize a training file's ASYNC (batch) indexing. Fired by AiBatchService
   * once the embedding batch reaches a terminal state. The file becomes INDEXED
   * ONLY when the batch completed, no request failed, and no chunk is left
   * unembedded — otherwise it is marked FAILED and its partial index removed.
   * This is the enforcement of "do not index a file until ALL embeddings are
   * complete and successfully saved."
   */
  @OnEvent(AiBatchCompletedEvent.eventName)
  async onBatchCompleted(event: AiBatchCompletedEvent): Promise<void> {
    if (event.sourceType !== 'training_file' || !event.sourceId) return;
    const file = await this.files.findOne({
      where: { id: event.sourceId, tenant: { id: event.tenantId } },
      relations: { agent: true },
    });
    if (!file || file.status !== TRAINING_FILE_STATUS.PROCESSING) return;

    const unembedded = await this.ingestion.countUnembeddedChunks(event.tenantId, file.id);
    const fullySucceeded =
      event.status === AI_BATCH_STATUS.COMPLETED && event.failedRequests === 0 && unembedded === 0;

    if (fullySucceeded) {
      file.status = TRAINING_FILE_STATUS.INDEXED;
      file.error_code = undefined;
      file.indexed_at = new Date();
      await this.files.save(file);
      return;
    }

    // Any shortfall → FAILED. Never leave a half-embedded index behind.
    await this.ingestion.cleanupSource(event.tenantId, file.id).catch(() => undefined);
    file.status = TRAINING_FILE_STATUS.FAILED;
    file.error_code =
      event.status === AI_BATCH_STATUS.COMPLETED ? 'EMBEDDING_INCOMPLETE' : `BATCH_${event.status}`;
    file.chunk_count = 0;
    file.indexed_at = undefined;
    await this.files.save(file);
    this.logger.warn(
      `Batch indexing finalized as FAILED tenant=${event.tenantId} file=${file.id} status=${event.status}`,
    );
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const file = await this.findOne(tenantId, id);
    await this.ingestion.cleanupSource(tenantId, id);
    if (!/^https?:\/\//i.test(file.file_url)) {
      this.storage.assertKeyBelongsToTenant(file.file_url, tenantId);
      await this.storage.deleteObject(file.file_url);
    }
    await this.files.remove(file);
  }

  private async assertAgent(tenantId: string, agentId: string): Promise<void> {
    if (!(await this.agents.exists({ where: { id: agentId, tenant: { id: tenantId } } }))) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'AI agent not found in this tenant' });
    }
  }

  private detectType(file: AiTrainingFile): string {
    if (file.file_type) return file.file_type.toUpperCase();
    const ext = file.file_name.split('.').pop()?.toUpperCase();
    return ext === 'MARKDOWN' ? 'MD' : (ext ?? 'UNKNOWN');
  }

  private async fail(file: AiTrainingFile, code: string, message: string): Promise<AiTrainingFile> {
    file.status = TRAINING_FILE_STATUS.FAILED;
    file.error_code = code;
    file.indexed_at = undefined;
    file.chunk_count = 0;
    await this.files.save(file);
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message });
  }
}
