import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { AiExecuteJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AiExecutionService } from '../../modules/ai/ai-execution.service';

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
  ) {
    super();
  }

  async process(job: Job<AiExecuteJob>) {
    const data = job.data;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] ${job.name} tenant=${data.tenantId} conv=${data.aiConversationId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, data, () =>
      this.exec.sendMessage(data.tenantId, data.aiConversationId, { content: data.content }),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
