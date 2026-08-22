import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { PlatformMaintenanceService } from '../../modules/platform/platform-maintenance.service';
import { AuthTokenMaintenanceService } from '../../modules/auth/auth-token-maintenance.service';

/**
 * Consumes the `platform` queue — the retention sweeps:
 *  - `platform.logCleanup`        purges aged api_logs / webhook_logs;
 *  - `platform.authTokenCleanup`  purges expired refresh_tokens / password_resets
 *                                 (AUTH-005 — see AuthTokenMaintenanceService).
 *
 * Now branches on the job NAME. It previously ignored it entirely and always
 * ran the log purge, which was harmless while one job existed and would have
 * silently mis-run the wrong sweep the moment a second one was added.
 */
@Processor(QUEUE.PLATFORM, { concurrency: workerConcurrency() })
export class PlatformProcessor extends WorkerHost {
  private readonly logger = new Logger('PlatformProcessor');

  constructor(
    private readonly maintenance: PlatformMaintenanceService,
    private readonly authTokens: AuthTokenMaintenanceService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case JOB.PLATFORM_AUTH_TOKEN_CLEANUP:
        return this.authTokens.purgeExpiredTokens();
      case JOB.PLATFORM_LOG_CLEANUP:
      default:
        // Default preserves the pre-existing behaviour for any job enqueued
        // onto this queue without a recognised name.
        return this.maintenance.purgeOldLogs();
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED: ${err?.message}`);
  }
}
