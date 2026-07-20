import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, Repository } from 'typeorm';

import { AiBatchJob } from '../../../entities/AI Agent/AiBatchJob';
import { AiBatchItem } from '../../../entities/AI Agent/AiBatchItem';
import {
  AI_BATCH_ENDPOINT,
  AI_BATCH_ITEM_STATUS,
  AI_BATCH_STATUS,
  AI_EXECUTION_MODE,
  AiFeature,
  isTerminalBatchStatus,
} from '../execution/ai-execution.constants';
import {
  AI_BATCH_PROVIDER,
  extractEmbeddingVector,
} from '../providers/ai-batch-provider.interface';
import type {
  AiBatchHandle,
  AiBatchLineRequest,
  AiBatchProvider,
} from '../providers/ai-batch-provider.interface';
import { AiExecutionPolicyService } from '../execution/ai-execution-policy.service';
import { AiDataResidencyService } from '../execution/ai-data-residency.service';
import { AiCostLedgerService } from '../cost/ai-cost-ledger.service';
import { AiKnowledgeIngestionService } from '../ingestion/ai-knowledge-ingestion.service';
import { AiBatchCompletedEvent } from '../../../events/ai-batch.events';

/** One chunk to embed via the batch route. `targetRef` is its ai_knowledge_bases id. */
export interface BatchEmbeddingItem {
  content: string;
  targetRef: string;
}

export interface SubmitEmbeddingBatchInput {
  tenantId: string;
  feature: AiFeature;
  agentId: string;
  items: BatchEmbeddingItem[];
  /** Stable across retries — the queue-layer + row-level idempotency key. */
  idempotencyKey: string;
  sourceType?: string;
  sourceId?: string;
  model?: string;
}

/**
 * Orchestrates OpenAI Batch API jobs (async execution mode).
 *
 * Submission is idempotent on (tenant, idempotency_key): a retried submit reuses
 * the existing job and never creates a second remote batch (no duplicate spend).
 * Result processing is transactional and idempotent — bound by `custom_id`
 * (never positional order), safe to re-run, and a completed item's embedding is
 * upserted (never duplicated). Cost is priced at the BATCH rate and recorded in
 * the same transaction that writes the embeddings.
 *
 * Tenant isolation: every query filters `tenant_id`; results only ever write to
 * chunks owned by the job's tenant + agent.
 */
@Injectable()
export class AiBatchService {
  private readonly logger = new Logger(AiBatchService.name);

  constructor(
    @InjectRepository(AiBatchJob) private readonly jobs: Repository<AiBatchJob>,
    @InjectRepository(AiBatchItem) private readonly items: Repository<AiBatchItem>,
    @Inject(AI_BATCH_PROVIDER) private readonly provider: AiBatchProvider,
    private readonly ingestion: AiKnowledgeIngestionService,
    private readonly residency: AiDataResidencyService,
    private readonly policy: AiExecutionPolicyService,
    private readonly costs: AiCostLedgerService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly emitter: EventEmitter2,
  ) {}

  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  /**
   * Submit an embedding batch. Idempotent: returns the existing job untouched if
   * one already exists for (tenant, idempotencyKey). Empty item lists are a
   * no-op and never create a remote batch.
   */
  async submitEmbeddingBatch(input: SubmitEmbeddingBatchInput): Promise<AiBatchJob> {
    const model = input.model ?? this.ingestion.currentEmbeddingModel();
    // Stamp the residency region/deployment the request will be processed in
    // (null when residency is disabled). A fail-closed residency throw aborts
    // submission before any remote batch is created.
    const decision = await this.residency.resolve(input.tenantId);

    const { job, created } = await this.claimJob({
      tenantId: input.tenantId,
      feature: input.feature,
      endpoint: AI_BATCH_ENDPOINT.EMBEDDINGS,
      model,
      idempotencyKey: input.idempotencyKey,
      agentId: input.agentId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      region: decision.region,
      deploymentId: decision.deploymentId,
    });
    // Retry / duplicate submit: never re-create the remote batch.
    if (!created) return job;

    if (input.items.length === 0) {
      await this.jobs.update({ id: job.id }, {
        status: AI_BATCH_STATUS.COMPLETED,
        total_requests: 0,
        completed_at: new Date(),
      });
      return this.jobs.findOneByOrFail({ id: job.id });
    }

    // Persist item rows (idempotent per custom_id) BEFORE submitting, so a crash
    // after remote creation can still bind results on the next poll.
    await this.insertItems(job.id, input.tenantId, input.items, input.sourceType, input.sourceId);

    const requests: AiBatchLineRequest[] = input.items.map((it) => ({
      customId: it.targetRef,
      method: 'POST',
      url: AI_BATCH_ENDPOINT.EMBEDDINGS,
      body: { model, input: it.content },
    }));

    try {
      const handle = await this.provider.submit({
        tenantId: input.tenantId,
        endpoint: AI_BATCH_ENDPOINT.EMBEDDINGS,
        requests,
        metadata: { feature: input.feature, source: input.sourceId ?? '' },
      });
      await this.jobs.update({ id: job.id }, {
        external_batch_id: handle.externalId,
        input_file_id: handle.inputFileId ?? null,
        status: handle.status === AI_BATCH_STATUS.PENDING ? AI_BATCH_STATUS.SUBMITTED : handle.status,
        total_requests: requests.length,
        submitted_at: new Date(),
      });
    } catch (err) {
      // Submission failed BEFORE we recorded an external id: mark FAILED so it is
      // terminal and a caller can re-submit under a fresh idempotency key rather
      // than risk a duplicate remote batch.
      this.logger.error(`Batch submit failed job=${job.id}: ${(err as Error).message}`);
      await this.jobs.update({ id: job.id }, {
        status: AI_BATCH_STATUS.FAILED,
        error_code: 'SUBMIT_FAILED',
        completed_at: new Date(),
      });
      throw err;
    }
    return this.jobs.findOneByOrFail({ id: job.id });
  }

  /**
   * Poll every non-terminal job that has a remote id, and process any that have
   * reached a terminal state. Also reaps stale PENDING jobs (submission crashed
   * before a remote batch id was recorded) so they don't linger forever.
   */
  async sweep(limit = 25): Promise<{ polled: number; finalized: number }> {
    if (!this.isConfigured()) return { polled: 0, finalized: 0 };
    await this.reapStalePending();

    const active = await this.jobs.find({
      where: {
        status: In([
          AI_BATCH_STATUS.SUBMITTED,
          AI_BATCH_STATUS.IN_PROGRESS,
          AI_BATCH_STATUS.FINALIZING,
          AI_BATCH_STATUS.CANCELLING,
        ]),
      },
      order: { updated_at: 'ASC' },
      take: limit,
    });

    let finalized = 0;
    for (const job of active) {
      try {
        if (await this.pollJob(job.id)) finalized += 1;
      } catch (err) {
        this.logger.warn(`Batch poll failed job=${job.id}: ${(err as Error).message}`);
      }
    }
    return { polled: active.length, finalized };
  }

  /** Poll one job; process results if terminal. Returns true when it finalized. */
  async pollJob(jobId: string): Promise<boolean> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job || !job.external_batch_id || isTerminalBatchStatus(job.status as never)) return false;

    const handle = await this.provider.poll(job.tenant_id, job.external_batch_id);
    if (!isTerminalBatchStatus(handle.status)) {
      await this.jobs.update({ id: job.id }, {
        status: handle.status,
        output_file_id: handle.outputFileId ?? null,
        error_file_id: handle.errorFileId ?? null,
        completed_requests: handle.counts.completed,
        failed_requests: handle.counts.failed,
      });
      return false;
    }
    await this.processResults(job, handle);
    return true;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /**
   * Apply a terminal batch's results in one transaction, idempotently. Binds
   * result lines to items by `custom_id`; writes each embedding to its chunk;
   * marks items COMPLETED/FAILED; prices the batch at the BATCH rate; flips the
   * job to its terminal status. A concurrent/retried call is a no-op (row lock +
   * terminal guard). Emits AiBatchCompletedEvent after commit.
   */
  private async processResults(job: AiBatchJob, handle: AiBatchHandle): Promise<void> {
    const { outputs, errors } =
      handle.outputFileId || handle.errorFileId
        ? await this.provider.fetchResults(job.tenant_id, handle)
        : { outputs: [], errors: [] };

    const finalStatus = handle.status;
    const outcome = await this.dataSource.transaction(async (m) => {
      const [locked] = (await m.query(
        `SELECT status FROM ai_batch_jobs WHERE id=$1 FOR UPDATE`,
        [job.id],
      )) as Array<{ status: string }>;
      if (!locked || isTerminalBatchStatus(locked.status as never)) return null; // already processed

      const itemRows = await m.getRepository(AiBatchItem).find({ where: { batch_job_id: job.id } });
      const byCustomId = new Map(itemRows.map((i) => [i.custom_id, i]));
      let embeddingTokens = 0;

      // Success lines: bind by custom_id, upsert the vector, mark COMPLETED.
      for (const line of outputs) {
        const item = byCustomId.get(line.customId);
        if (!item || item.status === AI_BATCH_ITEM_STATUS.COMPLETED) continue;
        if (line.error) {
          await this.markItem(m, item.id, AI_BATCH_ITEM_STATUS.FAILED, line.error.code ?? 'ERROR');
          continue;
        }
        const vector = extractEmbeddingVector(line.body);
        if (!vector) {
          await this.markItem(m, item.id, AI_BATCH_ITEM_STATUS.FAILED, 'NO_VECTOR');
          continue;
        }
        if (!item.target_ref || !job.agent_id) {
          await this.markItem(m, item.id, AI_BATCH_ITEM_STATUS.FAILED, 'NO_TARGET');
          continue;
        }
        const usage = (line.body?.usage ?? null) as { total_tokens?: number } | null;
        const tokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : 0;
        embeddingTokens += tokens;
        await this.ingestion.saveEmbedding(item.target_ref, job.tenant_id, job.agent_id, vector, m);
        await this.markItem(m, item.id, AI_BATCH_ITEM_STATUS.COMPLETED, null, tokens);
      }

      // Error lines: mark the matching item FAILED (bound by custom_id).
      for (const line of errors) {
        const item = byCustomId.get(line.customId);
        if (!item || item.status !== AI_BATCH_ITEM_STATUS.PENDING) continue;
        await this.markItem(m, item.id, AI_BATCH_ITEM_STATUS.FAILED, line.error?.code ?? 'BATCH_ERROR');
      }

      // Any item with no result at all (e.g. expired/cancelled before running).
      await m.query(
        `UPDATE ai_batch_items SET status='FAILED', error_code=COALESCE(error_code,'NO_RESULT'), updated_at=now()
         WHERE batch_job_id=$1 AND status='PENDING'`,
        [job.id],
      );

      // Recompute counts from the item rows (the source of truth) — idempotent.
      const [counts] = (await m.query(
        `SELECT count(*) FILTER (WHERE status='COMPLETED')::int AS completed,
                count(*) FILTER (WHERE status='FAILED')::int AS failed
           FROM ai_batch_items WHERE batch_job_id=$1`,
        [job.id],
      )) as Array<{ completed: number; failed: number }>;

      // Price the batch embeddings at the BATCH rate (never the standard rate).
      const quote = this.costs.quoteEmbedding(job.model, embeddingTokens, AI_EXECUTION_MODE.BATCH, job.provider);
      if (embeddingTokens > 0) {
        await this.costs.recordInTransaction(m, {
          tenantId: job.tenant_id,
          idempotencyKey: `batch:${job.id}:embedding`,
          requestKind: 'EMBEDDING',
          provider: job.provider,
          model: job.model,
          feature: job.feature,
          route: `ai.batch.${job.feature}`,
          channel: 'BATCH',
          executionMode: AI_EXECUTION_MODE.BATCH,
          region: job.region ?? null,
          batchJobId: job.id,
          embeddingTokens,
          success: true,
          quote,
        });
      }

      await m.query(
        `UPDATE ai_batch_jobs
            SET status=$2, completed_requests=$3, failed_requests=$4, embedding_tokens=$5,
                cost_microusd=$6, pricing_status=$7, output_file_id=$8, error_file_id=$9,
                error_code=$10, completed_at=now(), updated_at=now()
          WHERE id=$1`,
        [
          job.id, finalStatus, counts.completed, counts.failed, embeddingTokens,
          quote.costMicrousd?.toString() ?? null, quote.status,
          handle.outputFileId ?? null, handle.errorFileId ?? null,
          finalStatus === AI_BATCH_STATUS.COMPLETED ? null : `BATCH_${finalStatus}`,
        ],
      );
      return { completed: counts.completed, failed: counts.failed };
    });

    if (!outcome) return; // already finalized by a concurrent poll

    this.emitter.emit(
      AiBatchCompletedEvent.eventName,
      new AiBatchCompletedEvent(
        job.tenant_id, job.id, job.feature, finalStatus,
        job.source_type ?? null, job.source_id ?? null,
        handle.counts.total || (outcome.completed + outcome.failed),
        outcome.completed, outcome.failed,
      ),
    );
  }

  private async markItem(
    m: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    id: string,
    status: string,
    errorCode: string | null,
    inputTokens = 0,
  ): Promise<void> {
    await m.query(
      `UPDATE ai_batch_items SET status=$2, error_code=$3, input_tokens=$4, updated_at=now() WHERE id=$1`,
      [id, status, errorCode, inputTokens],
    );
  }

  /** Idempotent job claim on (tenant, idempotency_key). */
  private async claimJob(params: {
    tenantId: string;
    feature: string;
    endpoint: string;
    model: string;
    idempotencyKey: string;
    agentId?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    region?: string | null;
    deploymentId?: string | null;
  }): Promise<{ job: AiBatchJob; created: boolean }> {
    const inserted = (await this.dataSource.query(
      `INSERT INTO ai_batch_jobs
         (tenant_id, feature, execution_mode, provider, endpoint, model, status,
          idempotency_key, agent_id, source_type, source_id, region, deployment_id)
       VALUES ($1,$2,'BATCH','openai',$3,$4,'PENDING',$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        params.tenantId, params.feature, params.endpoint, params.model, params.idempotencyKey,
        params.agentId ?? null, params.sourceType ?? null, params.sourceId ?? null,
        params.region ?? null, params.deploymentId ?? null,
      ],
    )) as Array<{ id: string }>;
    const job = await this.jobs.findOneByOrFail({
      tenant_id: params.tenantId,
      idempotency_key: params.idempotencyKey,
    });
    return { job, created: !!inserted[0]?.id };
  }

  private async insertItems(
    jobId: string,
    tenantId: string,
    items: BatchEmbeddingItem[],
    sourceType?: string,
    sourceId?: string,
  ): Promise<void> {
    for (const it of items) {
      await this.dataSource.query(
        `INSERT INTO ai_batch_items (batch_job_id, tenant_id, custom_id, status, source_type, source_id, target_ref)
         VALUES ($1,$2,$3,'PENDING',$4,$5,$6)
         ON CONFLICT (batch_job_id, custom_id) DO NOTHING`,
        [jobId, tenantId, it.targetRef, sourceType ?? null, sourceId ?? null, it.targetRef],
      );
    }
  }

  /**
   * Mark PENDING jobs that never recorded a remote batch id (submission crashed)
   * as FAILED after a grace period, so they don't block the tenant forever.
   */
  private async reapStalePending(): Promise<void> {
    const graceMin = Number(this.config.get('AI_BATCH_SUBMIT_GRACE_MINUTES', 15));
    await this.dataSource.query(
      `UPDATE ai_batch_jobs SET status='FAILED', error_code='SUBMIT_INCOMPLETE', completed_at=now(), updated_at=now()
       WHERE status='PENDING' AND external_batch_id IS NULL
         AND created_at < now() - ($1 || ' minutes')::interval`,
      [String(graceMin)],
    );
  }
}
