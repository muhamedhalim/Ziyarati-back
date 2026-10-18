import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  Repository,
} from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, SubscriptionStatus } from '../../entities/enums';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';

import { AccessControlService } from './access-control.service';
import { BillingService } from './billing.service';

/** Bounds one page of the sweep. Cancelled rows leave the filter; skipped ones are passed by id. */
const PAGE_SIZE = 200;

/** Invoices that can still be paid — the ones an abandoned subscription leaves open. */
const UNPAID: InvoiceStatus[] = [
  InvoiceStatus.OPEN,
  InvoiceStatus.DRAFT,
  InvoiceStatus.UNCOLLECTIBLE,
];

export interface PendingPaymentExpirySummary {
  scanned: number;
  cancelled: number;
  /** A payment may still land (checkout open / charge unresolved), or the row changed under us. */
  skipped: number;
  /** TTL of 0 switches the sweep off. */
  disabled?: boolean;
}

/**
 * Cancels a paid-plan subscription that never got paid.
 *
 * With Tap a paid subscription starts `PENDING_PAYMENT` and waits for its first
 * invoice. Nothing used to end that wait: a clinic that abandoned checkout kept a
 * `PENDING_PAYMENT` subscription and an OPEN invoice forever (and the open invoice
 * holds the subscription's single OPEN slot). After
 * `SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS` (default 7; 0 = off) the abandoned
 * subscription is cancelled and its unpaid invoices voided.
 *
 *  - "Since when" is `subscriptions.updated_at`: every transition into
 *    PENDING_PAYMENT (a new subscription, a reactivation) and every re-quote saves
 *    the row, so the clock restarts whenever the clinic or the system touches it.
 *    (The column is `timestamp without time zone`, so the comparison can be off by the
 *    server/app timezone gap — hours, against a TTL counted in days: harmless here.)
 *  - NEVER while a payment may still land: an open hosted checkout or an unresolved
 *    saved-card charge (`BillingService.isPaymentInFlight`) skips the subscription;
 *    it is looked at again on the next run.
 *  - A payment that still arrives for a voided invoice is not booked and raises the
 *    existing ALERT in the settle path, exactly as for a user cancellation.
 *  - No notification is sent (a product decision); the audit row is the trail.
 *
 * Lock order matches `InvoiceSettlementService`: invoices first, then the
 * subscription — the reverse would deadlock against a settlement.
 */
@Injectable()
export class PendingPaymentExpiryService {
  private readonly logger = new Logger('PendingPaymentExpiryService');

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly dataSource: DataSource,
    private readonly billing: BillingService,
    private readonly access: AccessControlService,
    private readonly audit: PlatformAdminAuditService,
    private readonly config: ConfigService,
  ) {}

  ttlDays(): number {
    const raw = Number(
      this.config.get<number>('SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS', 7),
    );
    return Number.isFinite(raw) && raw >= 0 ? raw : 7;
  }

  async expireAbandoned(
    now: Date = new Date(),
  ): Promise<PendingPaymentExpirySummary> {
    const ttl = this.ttlDays();
    const summary: PendingPaymentExpirySummary = {
      scanned: 0,
      cancelled: 0,
      skipped: 0,
    };
    if (ttl === 0) return { ...summary, disabled: true };

    const cutoff = new Date(now.getTime() - ttl * 86_400_000);
    let afterId: string | undefined;
    for (;;) {
      const page = await this.subscriptions.find({
        where: {
          status: SubscriptionStatus.PENDING_PAYMENT,
          updated_at: LessThanOrEqual(cutoff),
          deleted_at: IsNull(),
          ...(afterId ? { id: MoreThan(afterId) } : {}),
        },
        select: { id: true, tenant: { id: true } },
        relations: { tenant: true },
        order: { id: 'ASC' },
        take: PAGE_SIZE,
      });
      if (page.length === 0) break;

      for (const s of page) {
        summary.scanned += 1;
        const done = await this.expireOne(s.id, s.tenant?.id, cutoff).catch(
          (err) => {
            this.logger.error(
              `Pending-payment expiry failed on subscription ${s.id}: ${(err as Error).message}`,
            );
            return false;
          },
        );
        if (done) summary.cancelled += 1;
        else summary.skipped += 1;
      }
      afterId = page[page.length - 1].id;
      if (page.length < PAGE_SIZE) break;
    }

    if (summary.scanned > 0) {
      this.logger.log(
        `pendingPaymentExpiry: scanned=${summary.scanned} cancelled=${summary.cancelled} skipped=${summary.skipped} (ttl ${ttl}d)`,
      );
    }
    return summary;
  }

  /** TRUE when the subscription was cancelled. */
  private async expireOne(
    subscriptionId: string,
    tenantId: string | undefined,
    cutoff: Date,
  ): Promise<boolean> {
    const voided = await this.dataSource.transaction(async (manager) => {
      const invRepo = manager.getRepository(SubscriptionInvoice);
      // 1. invoices (locked, no joins) …
      const unpaid = await invRepo.find({
        where: {
          subscription_id: subscriptionId,
          status: In(UNPAID),
        },
        lock: { mode: 'pessimistic_write' },
      });
      // 2. … then the subscription.
      const subRepo = manager.getRepository(Subscription);
      const sub = await subRepo.findOne({
        where: { id: subscriptionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !sub ||
        sub.status !== SubscriptionStatus.PENDING_PAYMENT ||
        sub.deleted_at ||
        sub.updated_at > cutoff
      ) {
        return null; // changed since the page was read: not abandoned any more
      }
      if (unpaid.some((i) => this.billing.isPaymentInFlight(i))) return null;

      for (const inv of unpaid) {
        inv.status = InvoiceStatus.VOID;
        inv.failure_reason = 'Subscription abandoned before payment';
        inv.charge_started_at = null;
        inv.next_retry_at = null;
      }
      if (unpaid.length > 0) await invRepo.save(unpaid);

      sub.status = SubscriptionStatus.CANCELLED;
      sub.auto_renew = false;
      sub.pending_plan = null;
      await subRepo.save(sub);
      return unpaid.map((i) => i.id);
    });
    if (!voided) return false;

    if (tenantId) this.access.invalidate(tenantId);
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_PENDING_PAYMENT_EXPIRED,
      userId: undefined,
      entityType: 'subscription',
      entityId: subscriptionId,
      tenantId,
      after: { voidedInvoiceIds: voided, ttlDays: this.ttlDays() },
    });
    return true;
  }
}
