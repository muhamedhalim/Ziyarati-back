import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { UsageReportService } from '../../modules/platform-usage/usage-report.service';
import { UsageReportRunJob } from '../../queue/job-data.interface';

/**
 * Consumes the `usage-report` queue. The repeatable TICK evaluates which
 * schedules are due and enqueues a RUN per schedule; each RUN builds + delivers
 * one report. All heavy lifting lives in `UsageReportService`.
 */
@Processor(QUEUE.USAGE_REPORT, { concurrency: workerConcurrency() })
export class UsageReportProcessor extends WorkerHost {
  private readonly logger = new Logger('UsageReportProcessor');

  constructor(private readonly reports: UsageReportService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === JOB.USAGE_REPORT_TICK) {
      const count = await this.reports.runDue();
      return { enqueued: count };
    }
    if (job.name === JOB.USAGE_REPORT_RUN) {
      const { scheduleId } = job.data as UsageReportRunJob;
      return this.reports.runSchedule(scheduleId);
    }
    return undefined;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED: ${err?.message}`);
  }
}
