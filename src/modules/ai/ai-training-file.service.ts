import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';

import { AiTrainingFile } from '../../entities/AI Agent/AiTrainingFile';
import { AiAgent } from '../../entities/AI Agent/AiAgent';
import { AiBatchJob } from '../../entities/AI Agent/AiBatchJob';
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
import {
  AI_EXECUTION_MODE,
  AI_FEATURE,
  isTerminalBatchStatus,
} from './execution/ai-execution.constants';
import { AiBatchCompletedEvent } from '../../events/ai-batch.events';
import { StorageService } from '../storage/storage.service';
import { AI_TRAINING_UPLOAD_POLICY } from '../storage/storage.constants';
import { UsageService } from '../subscription-billing/usage.service';

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
    @InjectRepository(AiBatchJob)
    private readonly batchJobs: Repository<AiBatchJob>,
    private readonly ingestion: AiKnowledgeIngestionService,
    private readonly batch: AiBatchService,
    private readonly policy: AiExecutionPolicyService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly usage: UsageService,
  ) {}

  /**
   * `max_training_files` — a real plan cap on a deliberate clinic upload,
   * denominated in BYTES (Pricing Catalog: "AI training files" is priced per
   * GB). Shared by both upload entry points (metadata registration and
   * direct content upload) so neither can bypass it. Scoped to AI_ASSISTANT,
   * so a tenant on a super-admin AI grant has no plan cap and passes.
   */
  private async assertTrainingFileQuota(
    tenantId: string,
    incomingSize: number,
  ): Promise<void> {
    await this.usage.assertResourceWithinLimit(
      tenantId,
      'trainingFiles',
      await this.usedBytes(tenantId),
      incomingSize,
    );
  }

  /** Sum of `file_size` across this tenant's training files — mirrors `FileUploadService.usedBytes`. */
  private async usedBytes(tenantId: string): Promise<number> {
    const row = await this.files
      .createQueryBuilder('f')
      .innerJoin('f.tenant', 't')
      .where('t.id = :tenantId', { tenantId })
      .select('COALESCE(SUM(f.file_size), 0)', 'bytes')
      .getRawOne<{ bytes: string }>();
    return Number(row?.bytes ?? 0);
  }

  async upload(
    tenantId: string,
    dto: UploadTrainingFileDto,
  ): Promise<AiTrainingFile> {
    const size = dto.fileSize ?? 0;
    await this.assertTrainingFileQuota(tenantId, size);
    if (dto.agentId) await this.assertAgent(tenantId, dto.agentId);
    this.storage.assertKeyBelongsToTenant(dto.fileUrl, tenantId);
    const file = this.files.create({
      tenant: { id: tenantId } as Tenant,
      agent: dto.agentId ? ({ id: dto.agentId } as AiAgent) : undefined,
      file_name: dto.fileName,
      file_url: dto.fileUrl,
      file_type: dto.fileType,
      file_size: size,
      status: TRAINING_FILE_STATUS.PENDING,
    });
    return this.files.save(file);
  }

  async uploadContent(
    tenantId: string,
    file: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
    agentId?: string,
  ): Promise<AiTrainingFile> {
    // Checked here as well as in `upload` below: this path writes the file to
    // private storage FIRST, and a quota refusal after that would leave an
    // orphaned object nothing references. `file.size` here is the REAL
    // multer-reported byte length (unlike `upload()`'s client-supplied
    // `dto.fileSize` on the metadata-registration path).
    await this.assertTrainingFileQuota(tenantId, file.size);
    if (agentId) await this.assertAgent(tenantId, agentId);
    const maxBytes = Number(
      this.config.get('AI_TRAINING_FILE_MAX_BYTES', 10 * 1024 * 1024),
    );
    if (
      !file.buffer?.length ||
      file.size > maxBytes ||
      file.buffer.length > maxBytes
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Training file is empty or exceeds the indexing size limit.',
      });
    }
    const stored = await this.storage.upload(
      {
        tenantId,
        docType: 'ai_training',
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      },
      AI_TRAINING_UPLOAD_POLICY,
    );
    return this.upload(tenantId, {
      fileName: stored.filename,
      fileUrl: stored.storageKey,
      fileType: file.mimetype === 'text/markdown' ? 'MD' : 'TXT',
      fileSize: file.size,
      agentId,
    });
  }

  async findAll(tenantId: string, filter: TrainingFileFilterDto) {
    const where: FindOptionsWhere<AiTrainingFile> = {
      tenant: { id: tenantId },
    };
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
    if (!file)
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Training file not found',
      });
    return file;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateTrainingFileDto,
  ): Promise<AiTrainingFile> {
    const file = await this.findOne(tenantId, id);
    if (dto.fileName !== undefined) file.file_name = dto.fileName;
    return this.files.save(file);
  }

  /** Physical PENDING/FAILED → PROCESSING → INDEXED/FAILED transition. */
  async process(tenantId: string, id: string): Promise<AiTrainingFile> {
    const file = await this.findOne(tenantId, id);
    if (file.status === TRAINING_FILE_STATUS.PROCESSING) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'Training file is already processing',
      });
    }
    if (file.status === TRAINING_FILE_STATUS.INDEXED) return file;
    if (!file.agent?.id)
      return this.fail(
        file,
        'AGENT_REQUIRED',
        'An AI agent is required before indexing.',
      );

    file.status = TRAINING_FILE_STATUS.PROCESSING;
    file.error_code = undefined;
    file.processing_started_at = new Date();
    file.indexed_at = undefined;
    file.attempts = (file.attempts ?? 0) + 1;
    await this.files.save(file);

    try {
      const type = this.detectType(file);
      if (!['TXT', 'MD'].includes(type)) {
        return this.fail(
          file,
          'UNSUPPORTED_EXTRACTOR',
          `No text extractor is configured for ${type}.`,
        );
      }
      if (/^https?:\/\//i.test(file.file_url)) {
        return this.fail(
          file,
          'EXTERNAL_URL_REJECTED',
          'Training files must use a tenant-owned private storage key.',
        );
      }
      const maxBytes = Number(
        this.config.get('AI_TRAINING_FILE_MAX_BYTES', 10 * 1024 * 1024),
      );
      const buffer = await this.storage.downloadObject(
        file.file_url,
        tenantId,
        maxBytes,
      );
      const text = buffer
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim();
      if (!text || text.includes('\uFFFD')) {
        return this.fail(
          file,
          'TEXT_EXTRACTION_FAILED',
          'The file is empty or is not valid UTF-8 text.',
        );
      }
      const contentHash = createHash('sha256')
        .update(text.normalize('NFKC'))
        .digest('hex');

      // Decide the route via the execution policy. Large files use the async
      // BATCH route when enabled; small files index synchronously. When batch is
      // DISABLED the policy applies the per-feature safe behavior — it will NOT
      // silently fan a very large file out synchronously (that FAILS with a clear
      // error rather than risking a huge single request / unexpected cost).
      const chunkCount = splitIntoChunks(text, {
        maxTokens: 500,
        overlapTokens: 60,
      }).length;
      const canBatch =
        this.batch.isConfigured() && this.ingestion.canStoreEmbeddings();
      const decision = this.policy.resolveEmbeddingExecution(
        AI_FEATURE.FILE_INDEXING,
        chunkCount,
      );

      if (decision.action === 'FAIL' || decision.action === 'DEFER') {
        return this.fail(
          file,
          'BATCH_REQUIRED_DISABLED',
          'This file is too large to index synchronously and the batch execution mode is disabled. ' +
            'Enable AI_BATCH_ENABLED to index large files.',
        );
      }

      if (decision.mode === AI_EXECUTION_MODE.BATCH && canBatch) {
        const prepared = await this.ingestion.prepareBatchDocument(
          tenantId,
          file.agent.id,
          text,
          file.id,
        );
        if (prepared.chunks <= 0) {
          return this.fail(
            file,
            'NO_INDEXABLE_CONTENT',
            'The file did not contain indexable text.',
          );
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
        // Persist PROCESSING BEFORE submitting so a crash during submission leaves
        // the file recoverable by reconcileProcessing (never stuck, never early-INDEXED).
        await this.files.save(file);
        try {
          await this.batch.submitEmbeddingBatch({
            tenantId,
            feature: AI_FEATURE.FILE_INDEXING,
            agentId: file.agent.id,
            items: prepared.pending.map((p) => ({ targetRef: p.kbId })),
            idempotencyKey: `training:${tenantId}:${file.id}:${contentHash}`,
            sourceType: 'training_file',
            sourceId: file.id,
          });
        } catch (err) {
          // A transient submission failure does NOT fail the file — the batch
          // submission reconciler retries. The file stays PROCESSING.
          this.logger.warn(
            `Batch submission deferred to reconciler tenant=${tenantId} file=${file.id}: ${(err as Error).message}`,
          );
        }
        return file;
      }

      // STANDARD synchronous indexing (small file, or batch unavailable & small).
      const result = await this.ingestion.ingestDocument(
        tenantId,
        file.agent.id,
        text,
        file.id,
        { requireEmbedding: true },
      );
      if (result.chunks + result.deduplicated <= 0) {
        return this.fail(
          file,
          'NO_INDEXABLE_CONTENT',
          'The file did not contain indexable text.',
        );
      }
      file.status = TRAINING_FILE_STATUS.INDEXED;
      file.error_code = undefined;
      file.chunk_count = result.chunks + result.deduplicated;
      file.content_hash = contentHash;
      file.indexed_at = new Date();
      return this.files.save(file);
    } catch (err) {
      if (
        err instanceof AppError &&
        file.status === TRAINING_FILE_STATUS.FAILED
      )
        throw err;
      await this.ingestion
        .cleanupSource(tenantId, file.id)
        .catch(() => undefined);
      const code =
        (err as Error).message === 'AI_EMBEDDING_UNAVAILABLE'
          ? 'EMBEDDING_UNAVAILABLE'
          : (err as Error).message === 'AI_EMBEDDING_INCOMPLETE'
            ? 'EMBEDDING_INCOMPLETE'
            : 'INDEXING_FAILED';
      this.logger.warn(
        `Training indexing failed tenant=${tenantId} file=${file.id} code=${code}`,
      );
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
   * Fast-path finalizer: the in-process completion event just TRIGGERS a
   * finalize; the decision is made from the DATABASE (the batch job row), never
   * from the event payload. So if the event is missed (crash/restart) the
   * periodic reconciler (`reconcileProcessing`) finalizes from the same DB state.
   */
  @OnEvent(AiBatchCompletedEvent.eventName)
  async onBatchCompleted(event: AiBatchCompletedEvent): Promise<void> {
    if (event.sourceType !== 'training_file' || !event.sourceId) return;
    await this.finalizeIndexing(event.tenantId, event.sourceId);
  }

  /**
   * DB-sourced, idempotent finalize for one training file. Reads the file's batch
   * job from the database (source of truth) and:
   *  - INDEXED only when the batch is COMPLETED, no request failed, and NO chunk
   *    is left unembedded — never earlier.
   *  - Otherwise FAILED with the partial index deleted (partial-failure policy).
   * Guarded by `status === PROCESSING`, so concurrent/repeated calls are no-ops.
   */
  async finalizeIndexing(tenantId: string, fileId: string): Promise<void> {
    const file = await this.files.findOne({
      where: { id: fileId, tenant: { id: tenantId } },
    });
    if (!file || file.status !== TRAINING_FILE_STATUS.PROCESSING) return;

    const job = await this.batchJobs.findOne({
      where: {
        tenant_id: tenantId,
        source_type: 'training_file',
        source_id: fileId,
      },
      order: { created_at: 'DESC' },
    });
    // No job yet (submission still in flight) or batch not terminal → revisit later.
    if (!job || !isTerminalBatchStatus(job.status as never)) return;

    const unembedded = await this.ingestion.countUnembeddedChunks(
      tenantId,
      fileId,
    );
    const fullySucceeded =
      job.status === 'COMPLETED' &&
      job.failed_requests === 0 &&
      unembedded === 0;

    if (fullySucceeded) {
      file.status = TRAINING_FILE_STATUS.INDEXED;
      file.error_code = undefined;
      file.indexed_at = new Date();
      await this.files.save(file);
      return;
    }

    // Partial-failure policy: fail the whole file and delete the partial index.
    await this.ingestion.cleanupSource(tenantId, fileId).catch(() => undefined);
    file.status = TRAINING_FILE_STATUS.FAILED;
    file.error_code =
      job.status === 'COMPLETED'
        ? 'EMBEDDING_INCOMPLETE'
        : `BATCH_${job.status}`;
    file.chunk_count = 0;
    file.indexed_at = undefined;
    await this.files.save(file);
    this.logger.warn(
      `Batch indexing finalized as FAILED tenant=${tenantId} file=${fileId} batch_status=${job.status}`,
    );
  }

  /**
   * Reconciliation sweep (worker): finalize any file stuck in PROCESSING whose
   * batch job has since reached a terminal state. This is the durable backstop
   * that makes the DB — not the in-process event — the source of truth, so a
   * crash between "all embeddings saved" and "event handled" cannot leave a file
   * PROCESSING forever.
   */
  async reconcileProcessing(
    limit = 50,
  ): Promise<{ scanned: number; finalized: number }> {
    const graceMin = Number(
      this.config.get('AI_TRAINING_FINALIZE_GRACE_MINUTES', 1),
    );
    const files = await this.files.find({
      where: { status: TRAINING_FILE_STATUS.PROCESSING },
      relations: { tenant: true },
      order: { processing_started_at: 'ASC' },
      take: limit,
    });
    let finalized = 0;
    for (const file of files) {
      // Give the synchronous path a moment before the reconciler intervenes.
      if (
        file.processing_started_at &&
        Date.now() - new Date(file.processing_started_at).getTime() <
          graceMin * 60_000
      )
        continue;
      const tenantId = file.tenant?.id;
      if (!tenantId) continue;
      await this.finalizeIndexing(tenantId, file.id);
      const after = await this.files.findOne({
        where: { id: file.id },
        select: { id: true, status: true },
      });
      if (after && after.status !== TRAINING_FILE_STATUS.PROCESSING)
        finalized += 1;
    }
    return { scanned: files.length, finalized };
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const file = await this.findOne(tenantId, id);
    await this.ingestion.cleanupSource(tenantId, id);
    if (!/^https?:\/\//i.test(file.file_url)) {
      await this.storage.deleteObject(file.file_url, tenantId);
    }
    await this.files.remove(file);
  }

  private async assertAgent(tenantId: string, agentId: string): Promise<void> {
    if (
      !(await this.agents.exists({
        where: { id: agentId, tenant: { id: tenantId } },
      }))
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'AI agent not found in this tenant',
      });
    }
  }

  private detectType(file: AiTrainingFile): string {
    if (file.file_type) return file.file_type.toUpperCase();
    const ext = file.file_name.split('.').pop()?.toUpperCase();
    return ext === 'MARKDOWN' ? 'MD' : (ext ?? 'UNKNOWN');
  }

  private async fail(
    file: AiTrainingFile,
    code: string,
    message: string,
  ): Promise<AiTrainingFile> {
    file.status = TRAINING_FILE_STATUS.FAILED;
    file.error_code = code;
    file.indexed_at = undefined;
    file.chunk_count = 0;
    await this.files.save(file);
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message });
  }
}
