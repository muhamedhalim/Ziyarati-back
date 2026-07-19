import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { PaymentsReconcileJob } from '../../queue/job-data.interface';
import { PaymentReconciliationService } from '../../modules/payments/payment-reconciliation.service';

/**
 * Consumes the `payments` queue (`payments.reconcile`) — a platform-level
 * scheduled sweep that re-verifies stale PENDING payments against the gateway
 * (webhook-loss recovery). Idempotent and safe on multiple replicas: every
 * decision is applied under the payment row lock with a state re-check.
 */
@Processor(QUEUE.PAYMENTS, { concurrency: workerConcurrency() })
export class PaymentsProcessor extends WorkerHost {
  private readonly logger = new Logger('PaymentsProcessor');

  constructor(private readonly reconciliation: PaymentReconciliationService) {
    super();
  }

  async process(_job: Job<PaymentsReconcileJob>) {
    return this.reconciliation.reconcileStalePending();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
