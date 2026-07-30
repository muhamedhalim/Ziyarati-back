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
 * Page size for the renewal-check sweep (L8 — docs/CACHING_QUEUES_AUDIT.md).
 * Bounds both the DB round-trip size and the peak resident set to one page's
 * worth of rows regardless of how many subscriptions are due at once.
 */
const RENEWAL_CHECK_PAGE_SIZE = 1000;

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

  /**
   * Gap-closure (L8 — docs/CACHING_QUEUES_AUDIT.md): the previous version
   * loaded EVERY due subscription in one unbounded `find()`, eagerly
   * hydrating the full `Tenant` relation just to read its `id` — fine at
   * today's tenant count, a real memory/latency risk once due subscriptions
   * routinely number in the tens of thousands on one renewal day. This is
   * not literally N+1 (`relations` performs one JOIN, not one query per
   * row) — the real issues were the unbounded result set and the
   * unnecessary full-entity hydration, both fixed here: page through in
   * bounded batches, and `select` only the `id` columns actually used
   * (`s.id`, `s.tenant.id`) instead of every `Tenant` column.
   */
  async process(_job: Job<SubscriptionsRenewalCheckJob>) {
    const cutoff = new Date(Date.now() + RENEWAL_WINDOW_DAYS * 86_400_000);
    const byTenant = new Map<string, number>();
    let total = 0;

    for (let offset = 0; ; offset += RENEWAL_CHECK_PAGE_SIZE) {
      const page = await this.subscriptions.find({
        where: {
          status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL]),
          ends_at: LessThanOrEqual(cutoff),
          deleted_at: IsNull(),
        },
        select: { id: true, tenant: { id: true } },
        relations: { tenant: true },
        order: { id: 'ASC' },
        skip: offset,
        take: RENEWAL_CHECK_PAGE_SIZE,
      });
      if (page.length === 0) break;

      total += page.length;
      for (const s of page) {
        const t = s.tenant?.id ?? 'unknown';
        byTenant.set(t, (byTenant.get(t) ?? 0) + 1);
      }
      if (page.length < RENEWAL_CHECK_PAGE_SIZE) break;
    }

    this.logger.log(
      `renewalCheck: ${total} subscription(s) due within ${RENEWAL_WINDOW_DAYS}d across ${byTenant.size} tenant(s)`,
    );
    return { due: total, tenants: byTenant.size };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`,
    );
  }
}
