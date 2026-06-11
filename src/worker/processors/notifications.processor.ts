import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { NotificationDispatchJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';

/**
 * Consumes the `notifications` queue. Reuses NotificationDispatchService (the
 * single send seam) — no business logic is reimplemented here. Idempotent at the
 * domain layer: processScheduled rejects already-terminal notifications, so a
 * redelivered job never double-sends.
 */
@Processor(QUEUE.NOTIFICATIONS, { concurrency: workerConcurrency() })
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger('NotificationsProcessor');

  constructor(
    private readonly dispatch: NotificationDispatchService,
    private readonly ctx: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<NotificationDispatchJob>) {
    const data = job.data;
    this.logger.log(
      `[cid=${data.correlationId ?? '-'}] ${job.name} tenant=${data.tenantId} id=${data.notificationId} attempt=${job.attemptsMade + 1}`,
    );
    return runInTenantContext(this.ctx, data, () =>
      this.dispatch.processScheduled(data.tenantId, data.notificationId),
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
