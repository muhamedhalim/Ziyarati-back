import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { AiExecuteJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { AiExecutionService } from '../../modules/ai/ai-execution.service';
import { AiBatchService } from '../../modules/ai/batch/ai-batch.service';
import { AiTrainingFileService } from '../../modules/ai/ai-training-file.service';
import { AiMemoryService } from '../../modules/ai-memory/ai-memory.service';

/**
 * Consumes the `ai` queue (`ai.execute`). Reuses AiExecutionService.sendMessage —
 * the existing transactional RAG turn (retrieve → assemble → provider → persist +
 * meter usage/cost). Used for ASYNC AI workflows; the interactive chat endpoint
 * stays synchronous (latency-sensitive) and is intentionally not rerouted.
 */
@Processor(QUEUE.AI, { concurrency: workerConcurrency() })
export class AiProcessor extends WorkerHost {
  private readonly logger = new Logger('AiProcessor');

  constructor(
    private readonly exec: AiExecutionService,
    private readonly ctx: TenantContextService,
    private readonly memory: AiMemoryService,
    private readonly batch: AiBatchService,
    private readonly trainingFiles: AiTrainingFileService,
    private readonly authz: WorkerAuthorizationService,
  ) {
    super();
  }

  async process(job: Job<AiExecuteJob>) {
    // Long-term memory expiry purge (platform-wide sweep, tenantId null).
    if (job.name === JOB.AI_MEMORY_CLEANUP) {
      const { deleted } = await this.memory.cleanupExpired();
      this.logger.log(`ai.memoryCleanup purged ${deleted} expired memories`);
      return { deleted };
    }

    // Batch poll sweep (platform-wide): poll live OpenAI batches and process any
    // that reached a terminal state. No-op when batch is unconfigured.
    if (job.name === JOB.AI_BATCH_POLL) {
      const result = await this.batch.sweep();
      // Durable backstop: finalize any training file stuck in PROCESSING whose
      // batch has since reached a terminal state (DB is the source of truth).
      const reconciled = await this.trainingFiles.reconcileProcessing();
      if (result.polled > 0 || reconciled.finalized > 0) {
        this.logger.log(
          `ai.batchPoll polled=${result.polled} finalized=${result.finalized} filesReconciled=${reconciled.finalized}`,
        );
      }
      return { ...result, filesReconciled: reconciled.finalized };
    }

    const data = job.data;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] ${job.name} tenant=${data.tenantId} conv=${data.aiConversationId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, this.authz, data, () =>
      this.exec.sendMessage(data.tenantId, data.aiConversationId, {
        content: data.content,
        idempotencyKey: data.idempotencyKey,
      }, 'BACKGROUND_JOB'),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
