import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AiBatchJob } from '../../../entities/AI Agent/AiBatchJob';
import { AiBatchItem } from '../../../entities/AI Agent/AiBatchItem';
import {
  AI_BATCH_ENDPOINT,
  AI_BATCH_ITEM_STATUS,
  AI_BATCH_STATUS,
  AI_EXECUTION_MODE,
  AiFeature,
  POLLABLE_BATCH_STATUSES,
  RECONCILE_SUBMISSION_STATUSES,
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
import { isAmbiguousOutcome } from '../providers/openai-request-policy';
import { AiDataResidencyService } from '../execution/ai-data-residency.service';
import { AiCostLedgerService } from '../cost/ai-cost-ledger.service';
import { AiKnowledgeIngestionService } from '../ingestion/ai-knowledge-ingestion.service';
import { AiBatchCompletedEvent } from '../../../events/ai-batch.events';

/** One chunk to embed via the batch route. `targetRef` is its ai_knowledge_bases id. */
export interface BatchEmbeddingItem {
  targetRef: string;
}

export interface SubmitEmbeddingBatchInput {
  tenantId: string;
  feature: AiFeature;
  agentId: string;
  items: BatchEmbeddingItem[];
  /** Stable across retries — the row-level idempotency key. */
  idempotencyKey: string;
  sourceType?: string;
  sourceId?: string;
  model?: string;
}

/**
 * Orchestrates OpenAI Batch API jobs (async execution mode).
 *
 * Submission is a crash-safe state machine
 * (PREPARING → UPLOADING → SUBMITTING → SUBMITTED, with SUBMISSION_UNKNOWN for an
 * uncertain create outcome). A retried submit reuses the existing row and never
 * creates a second remote batch; an uncertain create is reconciled by correlation
 * id before any decision. Result processing is transactional and idempotent —
 * bound by opaque `custom_id`, never positional order — and priced at the BATCH
 * rate. Polling is concurrency-safe (lease via next_poll_at + SKIP LOCKED) with
 * backoff. Tenant isolation: every query filters `tenant_id`; results only ever
 * write to chunks owned by the job's tenant + agent.
 */
@Injectable()
export class AiBatchService {
  private readonly logger = new Logger(AiBatchService.name);

  constructor(
    @InjectRepository(AiBatchJob) private readonly jobs: Repository<AiBatchJob>,
    @InjectRepository(AiBatchItem)
    private readonly items: Repository<AiBatchItem>,
    @Inject(AI_BATCH_PROVIDER) private readonly provider: AiBatchProvider,
    private readonly ingestion: AiKnowledgeIngestionService,
    private readonly residency: AiDataResidencyService,
    private readonly costs: AiCostLedgerService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly emitter: EventEmitter2,
  ) {}

  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  // ───────────────────────────── Submission ──────────────────────────────── //

  /**
   * Submit an embedding batch. Idempotent on (tenant, idempotencyKey): a retried
   * call resumes the existing job's submission rather than creating a new remote
   * batch. Empty item lists complete immediately without a remote batch.
   */
  async submitEmbeddingBatch(
    input: SubmitEmbeddingBatchInput,
  ): Promise<AiBatchJob> {
    const model = input.model ?? this.ingestion.currentEmbeddingModel();
    // Resolve (and VERIFY) residency first — a fail-closed throw aborts before any
    // row is created or byte uploaded.
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

    // Retry of an existing job → resume from its persisted state (never recreate).
    if (!created) return this.resumeSubmission(job);

    if (input.items.length === 0) {
      await this.jobs.update(
        { id: job.id },
        {
          status: AI_BATCH_STATUS.COMPLETED,
          total_requests: 0,
          completed_at: new Date(),
        },
      );
      return this.jobs.findOneByOrFail({ id: job.id });
    }

    await this.insertItems(
      job.id,
      input.tenantId,
      input.items.map((i) => i.targetRef),
      input.sourceType,
      input.sourceId,
    );
    return this.performSubmission(job.id);
  }

  /** Resume a job whose submit was retried, based on its persisted state. */
  private async resumeSubmission(job: AiBatchJob): Promise<AiBatchJob> {
    if (
      isTerminalBatchStatus(job.status as never) ||
      (POLLABLE_BATCH_STATUSES as string[]).includes(job.status)
    ) {
      return job; // already submitted / running / done — nothing to do
    }
    return this.performSubmission(job.id);
  }

  /**
   * Drive the submission state machine for one job. Persists remote ids the
   * moment they are obtained and NEVER re-creates a remote batch on an uncertain
   * outcome. Throws on submission failure (the caller/reconciler retries).
   */
  private async performSubmission(jobId: string): Promise<AiBatchJob> {
    // Concurrency guard: exactly ONE worker submits a given job at a time.
    // Winning this lease (bumping next_poll_at into the future) blocks a
    // concurrent submit/reconcile from double-uploading or creating a duplicate
    // remote batch. The lease is a timestamp — NO row lock is held across the
    // upload/create network calls; a crash simply lets the lease expire and the
    // reconciler re-claim.
    if (!(await this.claimSubmissionLease(jobId))) {
      return this.jobs.findOneByOrFail({ id: jobId });
    }
    let job = await this.jobs.findOneByOrFail({ id: jobId });
    // Ensure the item rows exist (crash before insert, or a racer that won the
    // lease before the caller's insert committed) by deriving from the source.
    await this.ensureItems(job);

    // 1) Upload the input file (unless already uploaded).
    if (!job.input_file_id) {
      await this.setStatus(job.id, AI_BATCH_STATUS.UPLOADING);
      const requests = await this.buildRequests(job);
      if (requests.length === 0) {
        await this.jobs.update(
          { id: job.id },
          {
            status: AI_BATCH_STATUS.COMPLETED,
            total_requests: 0,
            completed_at: new Date(),
          },
        );
        return this.jobs.findOneByOrFail({ id: job.id });
      }
      try {
        const { inputFileId } = await this.provider.uploadInputFile(
          job.tenant_id,
          requests,
        );
        await this.jobs.update(
          { id: job.id },
          {
            input_file_id: inputFileId,
            status: AI_BATCH_STATUS.SUBMITTING,
            total_requests: requests.length,
            last_error: null,
          },
        );
        job = await this.jobs.findOneByOrFail({ id: job.id });
      } catch (err) {
        // Upload is safe to retry (a dangling remote file is harmless). Stay
        // UPLOADING; the reconciler retries.
        await this.recordSubmitError(job.id, AI_BATCH_STATUS.UPLOADING, err);
        throw err;
      }
    }

    // 2) Create the remote batch (unless already created).
    if (!job.external_batch_id) {
      await this.setStatus(job.id, AI_BATCH_STATUS.SUBMITTING);
      try {
        const handle = await this.provider.createBatch({
          tenantId: job.tenant_id,
          inputFileId: job.input_file_id!,
          endpoint: job.endpoint,
          metadata: {
            correlation_id: job.correlation_id ?? '',
            feature: job.feature,
          },
        });
        await this.jobs.update(
          { id: job.id },
          {
            external_batch_id: handle.externalId,
            status: handle.status,
            submitted_at: new Date(),
            next_poll_at: new Date(),
            last_error: null,
          },
        );
      } catch (err) {
        // Ambiguous (no HTTP response) → the batch MAY exist; do NOT recreate.
        // Definitive (HTTP error) → not created; a create retry is safe.
        const ambiguous = isAmbiguousOutcome(err);
        await this.recordSubmitError(
          job.id,
          ambiguous
            ? AI_BATCH_STATUS.SUBMISSION_UNKNOWN
            : AI_BATCH_STATUS.SUBMITTING,
          err,
        );
        throw err;
      }
    }
    return this.jobs.findOneByOrFail({ id: job.id });
  }

  /** Build the JSONL requests for a job from its PENDING items + chunk content. */
  private async buildRequests(job: AiBatchJob): Promise<AiBatchLineRequest[]> {
    const items = await this.items.find({
      where: { batch_job_id: job.id, status: AI_BATCH_ITEM_STATUS.PENDING },
      order: { chunk_index: 'ASC' },
    });
    const targetRefs = items
      .map((i) => i.target_ref)
      .filter((r): r is string => !!r);
    const contents = await this.ingestion.contentsByIds(
      job.tenant_id,
      targetRefs,
    );
    const requests: AiBatchLineRequest[] = [];
    for (const item of items) {
      const content = item.target_ref
        ? contents.get(item.target_ref)
        : undefined;
      if (content == null) {
        await this.items.update(
          { id: item.id },
          {
            status: AI_BATCH_ITEM_STATUS.FAILED,
            error_code: 'NO_CONTENT',
          },
        );
        continue;
      }
      requests.push({
        customId: item.custom_id,
        method: 'POST',
        url: job.endpoint,
        body: { model: job.model, input: content },
      });
    }
    return requests;
  }

  /**
   * Atomically claim the right to submit this job (compare-and-swap on a lease
   * timestamp). Returns false when another worker already holds the lease (or the
   * job has advanced past submission) — the caller then no-ops. The lease is
   * aligned with the reconcile grace, so a crashed submission is retried only
   * after the lease expires. No lock is held across the network.
   */
  private async claimSubmissionLease(jobId: string): Promise<boolean> {
    const leaseSec = Number(
      this.config.get('AI_BATCH_SUBMIT_LEASE_SECONDS', 120),
    );
    const raw = await this.dataSource.query(
      `UPDATE ai_batch_jobs
          SET next_poll_at = now() + ($2 || ' seconds')::interval, updated_at = now()
        WHERE id = $1
          AND status IN ('PREPARING','UPLOADING','SUBMITTING','SUBMISSION_UNKNOWN')
          AND (next_poll_at IS NULL OR next_poll_at <= now())
        RETURNING id`,
      [jobId, String(leaseSec)],
    );
    return this.updateReturning(raw).length > 0;
  }

  /**
   * TypeORM's `query()` returns `[rows, affectedCount]` for `UPDATE … RETURNING`
   * (whereas `INSERT … RETURNING` returns the rows directly). Normalize to the
   * rows array. Getting this wrong silently breaks the lease (an empty result's
   * `.length` is 2, i.e. "always won") and polling (`.map` yields undefined ids)
   * — caught only by the real-Postgres integration test, not the mocked units.
   */
  private updateReturning<T = { id: string }>(raw: unknown): T[] {
    if (Array.isArray(raw) && Array.isArray(raw[0])) return raw[0] as T[];
    return Array.isArray(raw) ? (raw as T[]) : [];
  }

  /**
   * Ensure a job's item rows exist. Derives them from the source's still-
   * unembedded chunks when absent (crash before the caller's insert, or a racer
   * that won the lease first). Deterministic order + ON CONFLICT keeps it
   * duplicate-free across retries.
   */
  private async ensureItems(job: AiBatchJob): Promise<void> {
    if (await this.items.count({ where: { batch_job_id: job.id } })) return;
    if (!job.source_id) return;
    const targetRefs = await this.ingestion.unembeddedChunkIds(
      job.tenant_id,
      job.source_id,
    );
    if (targetRefs.length === 0) return;
    await this.insertItems(
      job.id,
      job.tenant_id,
      targetRefs,
      job.source_type,
      job.source_id,
    );
  }

  /**
   * Reconcile submissions whose outcome is uncertain or incomplete
   * (UPLOADING / SUBMITTING / SUBMISSION_UNKNOWN) or stuck in PREPARING. Verifies
   * via the correlation id before ever creating a new remote batch, so a crash
   * during submission cannot spawn a duplicate. Bounded by attempts/age; an
   * exhausted job is left FAILED but fully inspectable (manual-recovery-safe).
   */
  async reconcileSubmissions(
    limit = 20,
  ): Promise<{ scanned: number; recovered: number }> {
    if (!this.isConfigured()) return { scanned: 0, recovered: 0 };
    const graceSec = Number(
      this.config.get('AI_BATCH_SUBMIT_RECONCILE_GRACE_SECONDS', 120),
    );
    const maxAttempts = Number(
      this.config.get('AI_BATCH_SUBMIT_MAX_ATTEMPTS', 5),
    );
    const stuck = await this.jobs.find({
      where: {
        status: In([
          AI_BATCH_STATUS.PREPARING,
          ...RECONCILE_SUBMISSION_STATUSES,
        ]),
      },
      order: { updated_at: 'ASC' },
      take: limit,
    });
    const now = Date.now();
    let recovered = 0;
    for (const job of stuck) {
      if (now - new Date(job.updated_at).getTime() < graceSec * 1000) continue;
      try {
        if (await this.reconcileOne(job, maxAttempts)) recovered += 1;
      } catch (err) {
        this.logger.warn(
          `Submission reconcile failed job=${job.id}: ${(err as Error).message}`,
        );
      }
    }
    return { scanned: stuck.length, recovered };
  }

  private async reconcileOne(
    job: AiBatchJob,
    maxAttempts: number,
  ): Promise<boolean> {
    // 1) If a remote batch might exist, adopt it instead of creating a new one.
    if (
      job.correlation_id &&
      (job.status === AI_BATCH_STATUS.SUBMISSION_UNKNOWN ||
        job.status === AI_BATCH_STATUS.SUBMITTING)
    ) {
      const remote = await this.provider.findByCorrelation(
        job.tenant_id,
        job.correlation_id,
      );
      if (remote) {
        await this.jobs.update(
          { id: job.id },
          {
            external_batch_id: remote.externalId,
            input_file_id: job.input_file_id ?? remote.inputFileId ?? null,
            status: remote.status,
            submitted_at: job.submitted_at ?? new Date(),
            next_poll_at: new Date(),
            last_error: null,
          },
        );
        return true;
      }
    }

    // 2) Give up safely after too many attempts (row retained for manual recovery).
    if ((job.poll_attempts ?? 0) >= maxAttempts) {
      await this.jobs.update(
        { id: job.id },
        {
          status: AI_BATCH_STATUS.FAILED,
          error_code: 'SUBMISSION_RECONCILE_EXHAUSTED',
          completed_at: new Date(),
        },
      );
      return false;
    }
    await this.jobs.increment({ id: job.id }, 'poll_attempts', 1);

    // 3) Continue the submission from wherever it stalled. performSubmission
    //    claims the lease and (re-)derives items if they were never persisted.
    await this.performSubmission(job.id);
    return true;
  }

  // ───────────────────────────── Polling ─────────────────────────────────── //

  /**
   * One sweep: reconcile uncertain submissions, expire stuck jobs, then lease and
   * poll a bounded page of due, active jobs. Paginated (never loads all jobs) and
   * concurrency-safe (lease via next_poll_at + FOR UPDATE SKIP LOCKED).
   */
  async sweep(limit?: number): Promise<{ polled: number; finalized: number }> {
    if (!this.isConfigured()) return { polled: 0, finalized: 0 };
    const pageSize =
      limit ?? Number(this.config.get('AI_BATCH_POLL_PAGE_SIZE', 25));
    await this.reconcileSubmissions();
    await this.expireStuckJobs();

    const leased = await this.leasePollableJobs(pageSize);
    let finalized = 0;
    for (const jobId of leased) {
      try {
        if (await this.pollJob(jobId)) finalized += 1;
      } catch (err) {
        this.logger.warn(
          `Batch poll failed job=${jobId}: ${(err as Error).message}`,
        );
      }
    }
    return { polled: leased.length, finalized };
  }

  /**
   * Atomically lease a page of due, active jobs by pushing their next_poll_at
   * forward (a lease), so concurrent workers never poll the same job. The lease is
   * released/updated by pollJob once the network poll returns — no row lock is
   * held across the network call.
   */
  private async leasePollableJobs(limit: number): Promise<string[]> {
    const leaseSec = Number(this.config.get('AI_BATCH_POLL_LEASE_SECONDS', 60));
    const raw = await this.dataSource.query(
      `UPDATE ai_batch_jobs SET next_poll_at = now() + ($2 || ' seconds')::interval, updated_at = now()
        WHERE id IN (
          SELECT id FROM ai_batch_jobs
           WHERE status IN ('SUBMITTED','IN_PROGRESS','FINALIZING','CANCELLING')
             AND external_batch_id IS NOT NULL
             AND (next_poll_at IS NULL OR next_poll_at <= now())
           ORDER BY next_poll_at NULLS FIRST
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [limit, String(leaseSec)],
    );
    return this.updateReturning<{ id: string }>(raw).map((r) => r.id);
  }

  /** Poll one job; process results if terminal, else reschedule with backoff. */
  async pollJob(jobId: string): Promise<boolean> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (
      !job ||
      !job.external_batch_id ||
      isTerminalBatchStatus(job.status as never)
    )
      return false;

    const handle = await this.provider.poll(
      job.tenant_id,
      job.external_batch_id,
    );
    if (!isTerminalBatchStatus(handle.status)) {
      const attempts = (job.poll_attempts ?? 0) + 1;
      await this.jobs.update(
        { id: job.id },
        {
          status: handle.status,
          output_file_id: handle.outputFileId ?? null,
          error_file_id: handle.errorFileId ?? null,
          completed_requests: handle.counts.completed,
          failed_requests: handle.counts.failed,
          poll_attempts: attempts,
          next_poll_at: new Date(
            Date.now() + this.backoffSeconds(attempts) * 1000,
          ),
        },
      );
      return false;
    }
    await this.processResults(job, handle);
    return true;
  }

  /** Exponential-ish poll backoff (seconds), capped. */
  private backoffSeconds(attempts: number): number {
    const base = Number(
      this.config.get('AI_BATCH_POLL_BACKOFF_BASE_SECONDS', 30),
    );
    const cap = Number(
      this.config.get('AI_BATCH_POLL_BACKOFF_MAX_SECONDS', 900),
    );
    return Math.min(
      cap,
      Math.floor(base * 2 ** Math.min(6, Math.max(0, attempts - 1))),
    );
  }

  /** Expire jobs that never reached a terminal state within the max window. */
  private async expireStuckJobs(): Promise<void> {
    const maxHours = Number(this.config.get('AI_BATCH_MAX_AGE_HOURS', 26));
    await this.dataSource.query(
      `UPDATE ai_batch_jobs
          SET status='EXPIRED', error_code='MAX_AGE_EXCEEDED', completed_at=now(), updated_at=now()
        WHERE status IN ('SUBMITTED','IN_PROGRESS','FINALIZING','CANCELLING','SUBMITTING','SUBMISSION_UNKNOWN','UPLOADING','PREPARING')
          AND created_at < now() - ($1 || ' hours')::interval`,
      [String(maxHours)],
    );
  }

  // ─────────────────────────── Result processing ─────────────────────────── //

  /**
   * Apply a terminal batch's results in one transaction, idempotently. Binds
   * result lines to items by `custom_id`; writes each embedding to its chunk;
   * marks items COMPLETED/FAILED; prices at the BATCH rate; flips the job to its
   * terminal status. Concurrent/retried calls are a no-op (row lock + terminal
   * guard). Emits AiBatchCompletedEvent after commit.
   */
  private async processResults(
    job: AiBatchJob,
    handle: AiBatchHandle,
  ): Promise<void> {
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

      const itemRows = await m
        .getRepository(AiBatchItem)
        .find({ where: { batch_job_id: job.id } });
      const byCustomId = new Map(itemRows.map((i) => [i.custom_id, i]));
      let embeddingTokens = 0;

      for (const line of outputs) {
        const item = byCustomId.get(line.customId);
        if (!item || item.status === AI_BATCH_ITEM_STATUS.COMPLETED) continue;
        if (line.error) {
          await this.markItem(
            m,
            item.id,
            AI_BATCH_ITEM_STATUS.FAILED,
            line.error.code ?? 'ERROR',
          );
          continue;
        }
        const vector = extractEmbeddingVector(line.body);
        if (!vector) {
          await this.markItem(
            m,
            item.id,
            AI_BATCH_ITEM_STATUS.FAILED,
            'NO_VECTOR',
          );
          continue;
        }
        if (!item.target_ref || !job.agent_id) {
          await this.markItem(
            m,
            item.id,
            AI_BATCH_ITEM_STATUS.FAILED,
            'NO_TARGET',
          );
          continue;
        }
        const usage = (line.body?.usage ?? null) as {
          total_tokens?: number;
        } | null;
        const tokens =
          typeof usage?.total_tokens === 'number' ? usage.total_tokens : 0;
        embeddingTokens += tokens;
        await this.ingestion.saveEmbedding(
          item.target_ref,
          job.tenant_id,
          job.agent_id,
          vector,
          m,
        );
        await this.markItem(
          m,
          item.id,
          AI_BATCH_ITEM_STATUS.COMPLETED,
          null,
          tokens,
        );
      }

      for (const line of errors) {
        const item = byCustomId.get(line.customId);
        if (!item || item.status !== AI_BATCH_ITEM_STATUS.PENDING) continue;
        await this.markItem(
          m,
          item.id,
          AI_BATCH_ITEM_STATUS.FAILED,
          line.error?.code ?? 'BATCH_ERROR',
        );
      }

      // Any item with no result at all (e.g. expired/cancelled before running).
      await m.query(
        `UPDATE ai_batch_items SET status='FAILED', error_code=COALESCE(error_code,'NO_RESULT'), updated_at=now()
         WHERE batch_job_id=$1 AND status='PENDING'`,
        [job.id],
      );

      const [counts] = (await m.query(
        `SELECT count(*) FILTER (WHERE status='COMPLETED')::int AS completed,
                count(*) FILTER (WHERE status='FAILED')::int AS failed
           FROM ai_batch_items WHERE batch_job_id=$1`,
        [job.id],
      )) as Array<{ completed: number; failed: number }>;

      // Price at the BATCH rate (never standard). Failed items produced no tokens.
      const quote = this.costs.quoteEmbedding(
        job.model,
        embeddingTokens,
        AI_EXECUTION_MODE.BATCH,
        job.provider,
      );
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
          job.id,
          finalStatus,
          counts.completed,
          counts.failed,
          embeddingTokens,
          quote.costMicrousd?.toString() ?? null,
          quote.status,
          handle.outputFileId ?? null,
          handle.errorFileId ?? null,
          finalStatus === AI_BATCH_STATUS.COMPLETED
            ? null
            : `BATCH_${finalStatus}`,
        ],
      );
      return { completed: counts.completed, failed: counts.failed };
    });

    if (!outcome) return; // already finalized by a concurrent poll

    this.emitter.emit(
      AiBatchCompletedEvent.eventName,
      new AiBatchCompletedEvent(
        job.tenant_id,
        job.id,
        job.feature,
        finalStatus,
        job.source_type ?? null,
        job.source_id ?? null,
        handle.counts.total || outcome.completed + outcome.failed,
        outcome.completed,
        outcome.failed,
      ),
    );
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

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

  private async setStatus(jobId: string, status: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status });
  }

  private async recordSubmitError(
    jobId: string,
    status: string,
    err: unknown,
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      {
        status,
        last_error: (err as Error).message?.slice(0, 200) ?? 'submit_error',
      },
    );
  }

  /** Idempotent job claim on (tenant, idempotency_key). Starts in PREPARING. */
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
          idempotency_key, correlation_id, agent_id, source_type, source_id, region, deployment_id)
       VALUES ($1,$2,'BATCH','openai',$3,$4,'PREPARING',$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        params.tenantId,
        params.feature,
        params.endpoint,
        params.model,
        params.idempotencyKey,
        randomUUID(),
        params.agentId ?? null,
        params.sourceType ?? null,
        params.sourceId ?? null,
        params.region ?? null,
        params.deploymentId ?? null,
      ],
    )) as Array<{ id: string }>;
    const job = await this.jobs.findOneByOrFail({
      tenant_id: params.tenantId,
      idempotency_key: params.idempotencyKey,
    });
    return { job, created: !!inserted[0]?.id };
  }

  /**
   * Persist item rows for a set of target chunks. `custom_id` is an OPAQUE UUID
   * (no tenant/file/patient data); the internal (job, source, chunk_index) unique
   * index — with chunk_index assigned by stable target-ref order — makes a
   * duplicate chunk mapping impossible even across retries.
   */
  private async insertItems(
    jobId: string,
    tenantId: string,
    targetRefs: string[],
    sourceType?: string | null,
    sourceId?: string | null,
  ): Promise<void> {
    const ordered = [...targetRefs].sort();
    for (let i = 0; i < ordered.length; i += 1) {
      await this.dataSource.query(
        `INSERT INTO ai_batch_items
           (batch_job_id, tenant_id, custom_id, status, source_type, source_id, chunk_index, target_ref)
         VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7)
         ON CONFLICT (batch_job_id, source_type, source_id, chunk_index) DO NOTHING`,
        [
          jobId,
          tenantId,
          randomUUID(),
          sourceType ?? null,
          sourceId ?? null,
          i,
          ordered[i],
        ],
      );
    }
  }
}
