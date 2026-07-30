import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import {
  QUEUE,
  SWEEP_FANOUT_PAGE_SIZE,
  workerConcurrency,
} from '../../queue/queue.constants';
import { SettlementsProcessJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { QueueService } from '../../queue/queue.service';
import { WorkerTenantsService } from '../worker-tenants.service';
import { SettlementService } from '../../modules/payments/settlement.service';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Consumes the `settlements` queue. Scheduled sweep (tenantId null) fans out a
 * per-tenant `settlements.process` job; the per-tenant job reuses
 * SettlementService.generate (batch UNSETTLED → settlement, transactional). A
 * tenant with nothing to settle is a successful no-op (not a failure), so empty
 * tenants don't pollute the failed set.
 */
@Processor(QUEUE.SETTLEMENTS, { concurrency: workerConcurrency() })
export class SettlementsProcessor extends WorkerHost {
  private readonly logger = new Logger('SettlementsProcessor');

  constructor(
    private readonly settlements: SettlementService,
    private readonly tenants: WorkerTenantsService,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
  ) {
    super();
  }

  async process(job: Job<SettlementsProcessJob>) {
    const data = job.data;

    if (!data.tenantId) {
      // Pages through active tenants and `addBulk`s each page (M7 —
      // docs/CACHING_QUEUES_AUDIT.md) instead of one unbounded tenant query
      // plus one `add()` per tenant.
      let offset = 0;
      let fannedOut = 0;
      for (;;) {
        const page = await this.tenants.activeTenantIdsPage(
          offset,
          SWEEP_FANOUT_PAGE_SIZE,
        );
        if (page.length === 0) break;
        await this.queue.enqueueSettlementsProcessBulk(
          page.map((tenantId) => ({
            tenantId,
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
            feePercent: data.feePercent,
            currency: data.currency,
          })),
        );
        fannedOut += page.length;
        offset += page.length;
        if (page.length < SWEEP_FANOUT_PAGE_SIZE) break;
      }
      this.logger.log(
        `settlements.process sweep fanned out ${fannedOut} tenant(s)`,
      );
      return { fannedOut };
    }

    return runInTenantContext(
      this.ctx,
      this.authz,
      job.name,
      data,
      async () => {
        try {
          const result = await this.settlements.generate(data.tenantId!, {
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
            branchId: data.branchId,
            feePercent: data.feePercent,
            currency: data.currency,
          });
          return {
            settled: true,
            settlementId: (result as { id?: string })?.id,
          };
        } catch (err) {
          // "Nothing to settle" is an expected no-op, not a job failure.
          if (
            err instanceof AppError &&
            err.code === ErrorCode.UNPROCESSABLE_ENTITY
          ) {
            this.logger.log(`tenant=${data.tenantId} has nothing to settle`);
            return { settled: false, reason: err.message };
          }
          throw err;
        }
      },
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
