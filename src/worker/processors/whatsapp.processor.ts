import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { scrubFailureReason } from '../../common/utils/log-scrubber.util';
import { Job, UnrecoverableError } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import {
  WhatsappSendJob,
  WhatsappCoexistenceSyncJob,
  WhatsappDlqJob,
} from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { validateJobPayload } from '../../queue/job-payload-validator';
import {
  isMinimized,
  minimizeCompletedJob,
} from '../../queue/job-pii-redaction';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { QueueService } from '../../queue/queue.service';
import { WhatsappExecutionService } from '../../modules/whatsapp/whatsapp-execution.service';
import { SendTemplateMessageDto } from '../../modules/whatsapp/dto/send-template-message.dto';
import { WHATSAPP_DELIVERY_STATUS } from '../../modules/whatsapp/whatsapp.constants';
import { WhatsappCoexistenceSyncService } from '../../modules/whatsapp/meta/whatsapp-coexistence-sync.service';

/**
 * Consumes the `whatsapp` queue (`whatsapp.send` + `whatsapp.retry`). Reuses
 * WhatsappExecutionService.sendTemplateMessage — the existing orchestration that
 * validates account/template/recipient and records the outcome on notification
 * logs. Retries are driven by BullMQ attempts/backoff.
 *
 * FND-022: `sendTemplateMessage` deliberately RETURNS `{status: FAILED}` for
 * a provider send failure rather than throwing — other callers (e.g.
 * `NotificationDispatchService.processScheduled`) rely on exactly that
 * return-not-throw contract for their OWN transient/permanent classification,
 * so it is not changed here. This processor is the seam that converts a
 * returned provider failure into a THROW, which is what a NestJS
 * `WorkerHost.process()` needs to make BullMQ actually retry instead of
 * marking the job `completed`. Exhausted retries are parked in
 * `WHATSAPP_DLQ`, mirroring `webhook-delivery.processor.ts`'s
 * exhausted/permanent → DLQ pattern (the established reference — inbound
 * webhook/media processors park on the same queue).
 */
@Processor(QUEUE.WHATSAPP_OUTBOUND, { concurrency: workerConcurrency() })
export class WhatsappProcessor extends WorkerHost {
  private readonly logger = new Logger('WhatsappProcessor');

  constructor(
    private readonly exec: WhatsappExecutionService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
    private readonly queue: QueueService,
    private readonly coexistenceSync: WhatsappCoexistenceSyncService,
  ) {
    super();
  }

  async process(job: Job<WhatsappSendJob | WhatsappCoexistenceSyncJob>) {
    const data = job.data;
    validateJobPayload(job.name, data);

    if (job.name === JOB.WHATSAPP_COEXISTENCE_SYNC) {
      const syncData = data as WhatsappCoexistenceSyncJob;
      this.logger.log(
        `[cid=${syncData.correlationId ?? '-'}] ${job.name} tenant=${syncData.tenantId} account=${syncData.accountId} attempt=${job.attemptsMade + 1}`,
      );
      return runInTenantContext(this.ctx, this.authz, job.name, syncData, () =>
        this.coexistenceSync.run(syncData.tenantId, syncData.accountId),
      );
    }

    if (isMinimized(data)) {
      // A completed job whose recipient/variables were dropped (P6) cannot be replayed.
      throw new UnrecoverableError(
        `${job.name} payload was minimised after completion`,
      );
    }

    const sendData = data as WhatsappSendJob;
    this.logger.log(
      `[cid=${sendData.correlationId ?? '-'}] ${job.name} tenant=${sendData.tenantId} template=${sendData.templateId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(
      this.ctx,
      this.authz,
      job.name,
      sendData,
      async () => {
        const result = await this.exec.sendTemplateMessage(
          sendData.tenantId,
          sendData.templateId,
          sendData.payload as SendTemplateMessageDto,
          sendData.logId ? { logId: sendData.logId } : undefined,
        );
        if (result?.status === WHATSAPP_DELIVERY_STATUS.FAILED) {
          // The execution service already recorded this outcome on the
          // notification log — throwing here is purely what drives BullMQ's
          // attempts/backoff; it does not duplicate that persistence.
          throw new Error(result.error ?? 'WhatsApp provider send failed');
        }
        return result;
      },
    );
  }

  /**
   * Residency plan P6: a sent message's recipient and template variables are
   * not left in Redis for the completed-job retention window. Only
   * `whatsapp.send` / `whatsapp.retry` are touched; other jobs on this queue
   * carry no content and are left alone.
   */
  @OnWorkerEvent('completed')
  async onCompleted(job: Job) {
    await minimizeCompletedJob(job, this.logger);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error) {
    // Logged at error by the job wrapper (common/logging/job-instrumentation.ts).
    this.logger.debug(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );

    const data = job?.data as WhatsappSendJob | undefined;
    if (!data) return;
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
    // UnrecoverableError (payload validation, worker authorization) never
    // retries, so `attemptsMade` never reaches `opts.attempts` — without this
    // branch such a job fails once and vanishes with no DLQ park, same gap
    // `webhook-delivery.processor.ts` closed for its own queue.
    const permanent = err instanceof UnrecoverableError;
    if (!exhausted && !permanent) return;

    await this.queue
      .enqueueWhatsappDlq({
        tenantId: data.tenantId,
        correlationId: data.correlationId,
        sourceQueue: QUEUE.WHATSAPP_OUTBOUND,
        sourceJobName: job.name,
        originalJobId: String(job?.id ?? ''),
        originalData: data as unknown as Record<string, unknown>,
        failedReason: scrubFailureReason(err),
        attemptsMade: job?.attemptsMade ?? 0,
        diedAt: new Date().toISOString(),
      } satisfies WhatsappDlqJob)
      .catch((e) =>
        this.logger.error(`DLQ enqueue failed: ${(e as Error)?.message}`),
      );
  }
}
