import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { WhatsappSendJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WhatsappExecutionService } from '../../modules/whatsapp/whatsapp-execution.service';
import { SendTemplateMessageDto } from '../../modules/whatsapp/dto/send-template-message.dto';

/**
 * Consumes the `whatsapp` queue (`whatsapp.send` + `whatsapp.retry`). Reuses
 * WhatsappExecutionService.sendTemplateMessage — the existing orchestration that
 * validates account/template/recipient and records the outcome on notification
 * logs. Retries are driven by BullMQ attempts/backoff.
 */
@Processor(QUEUE.WHATSAPP_OUTBOUND, { concurrency: workerConcurrency() })
export class WhatsappProcessor extends WorkerHost {
  private readonly logger = new Logger('WhatsappProcessor');

  constructor(
    private readonly exec: WhatsappExecutionService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<WhatsappSendJob>) {
    const data = job.data;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] ${job.name} tenant=${data.tenantId} template=${data.templateId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, data, () =>
      this.exec.sendTemplateMessage(
        data.tenantId,
        data.templateId,
        data.payload as SendTemplateMessageDto,
      ),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
