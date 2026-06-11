import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';

import { QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { SubscriptionsRenewalCheckJob } from '../../queue/job-data.interface';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';

const RENEWAL_WINDOW_DAYS = 3;

/**
 * Consumes the `subscriptions` queue (`subscriptions.renewalCheck`) — a global
 * scheduled sweep that detects subscriptions due for renewal/expiry.
 *
 * It is intentionally READ-ONLY: it reports what is due and is the wired seam for
 * renewal/dunning. The actual "issue invoice / mark past-due" action is NOT
 * implemented here because no such business logic exists in the domain yet, and
 * the brief forbids inventing/rewriting business rules. Once SubscriptionService
 * gains a renewal method, this processor calls it per due subscription.
 */
@Processor(QUEUE.SUBSCRIPTIONS, { concurrency: workerConcurrency() })
export class SubscriptionsProcessor extends WorkerHost {
  private readonly logger = new Logger('SubscriptionsProcessor');

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
  ) {
    super();
  }

  async process(_job: Job<SubscriptionsRenewalCheckJob>) {
    const cutoff = new Date(Date.now() + RENEWAL_WINDOW_DAYS * 86_400_000);
    const due = await this.subscriptions.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
        ends_at: LessThanOrEqual(cutoff),
        deleted_at: IsNull(),
      },
      relations: { tenant: true },
    });

    const byTenant = new Map<string, number>();
    for (const s of due) {
      const t = s.tenant?.id ?? 'unknown';
      byTenant.set(t, (byTenant.get(t) ?? 0) + 1);
    }
    this.logger.log(
      `renewalCheck: ${due.length} subscription(s) due within ${RENEWAL_WINDOW_DAYS}d across ${byTenant.size} tenant(s)`,
    );
    return { due: due.length, tenants: byTenant.size };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
