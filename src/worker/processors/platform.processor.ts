import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { PlatformMaintenanceService } from '../../modules/platform/platform-maintenance.service';

/**
 * Consumes the `platform` queue. Currently the retention sweep
 * (platform.logCleanup) that purges aged api_logs / webhook_logs.
 */
@Processor(QUEUE.PLATFORM, { concurrency: workerConcurrency() })
export class PlatformProcessor extends WorkerHost {
  private readonly logger = new Logger('PlatformProcessor');

  constructor(private readonly maintenance: PlatformMaintenanceService) {
    super();
  }

  async process(_job: Job) {
    return this.maintenance.purgeOldLogs();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED: ${err?.message}`);
  }
}
