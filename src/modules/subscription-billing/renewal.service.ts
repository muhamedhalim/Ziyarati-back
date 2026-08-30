import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { EmailService } from '../email/email.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';

import { BillingService } from './billing.service';
import { computeNextPeriodEnd } from './subscription-period.util';

/** Bounds the DB round-trip and resident set per page — same reasoning as
 *  `SubscriptionsProcessor`'s own `RENEWAL_CHECK_PAGE_SIZE`. */
const RENEWAL_BILL_PAGE_SIZE = 500;

/** +1/+3/+5 days — the retry schedule contracts/internal-seams.md §6 names. */
const RETRY_SCHEDULE_DAYS = [1, 3, 5];

export interface RenewalBillResult {
  due: number;
  attempted: number;
  settled: number;
  declined: number;
  skipped: number;
}

/**
 * Spec 014 (Clinic Platform Completion) — T080 (US5, contracts/internal-seams
 * .md §6). The renewal cycle: eligibility → period-scoped invoice upsert →
 * `BillingService.payInvoice` → settle or decline.
 *
 * Deliberately does NOT touch `Subscription.status` on decline, and does
 * NOT drive the PAST_DUE/GRACE_EXPIRED transitions at all — that state
 * machine already exists, unconditionally, in `SubscriptionsProcessor`'s
 * `transitionToGrace`/`transitionGraceExpired` (driven purely by `ends_at`/
 * `grace_started_at`, on the `renewalCheck` sweep), and duplicating it here
 * is exactly what T080 says not to do. This service only ever REVIVES a
 * subscription on a SUCCESSFUL charge (PAST_DUE → ACTIVE, period advanced);
 * every failure path is a no-op on `Subscription.status`, left entirely to
 * that existing sweep.
 *
 * Consequence worth stating plainly: because `renewalCheck` (02:00 UTC) and
 * `renewalBill` (02:15 UTC) are two different cron ticks on the SAME queue
 * (T024), a HEALTHY renewal still passes through a brief (~15 minute)
 * PAST_DUE state before this service revives it the same night — not a bug,
 * a direct consequence of not reimplementing the transition here.
 *
 * Idempotency is enforced at the DATABASE level (`UQ_sub_invoice_period`,
 * T079), not just by the worker's own lock: a period's invoice is created
 * via an atomic insert-or-fetch (same pattern as `TransactionService
 * .recordWebhookOnce`), and `BillingService.payInvoice`'s own charge-claim
 * already makes a concurrent charge attempt on one invoice a 409, not a
 * second provider call. Two overlapping sweeps — lock lost to a Redis
 * failure, or a crashed run retried — still produce at most one invoice and
 * one charge attempt per period.
 */
@Injectable()
export class RenewalService {
  private readonly logger = new Logger('RenewalService');

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    private readonly billing: BillingService,
    private readonly platformSettings: SystemSettingService,
    private readonly audit: PlatformAdminAuditService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private graceDurationDays(): number {
    return this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14);
  }

  /**
   * The daily pass: every PAST_DUE, auto-renewing subscription either gets
   * its first charge attempt for the current period, or a due retry.
   */
  async processDueBills(): Promise<RenewalBillResult> {
    const result: RenewalBillResult = {
      due: 0,
      attempted: 0,
      settled: 0,
      declined: 0,
      skipped: 0,
    };

    for (let offset = 0; ; offset += RENEWAL_BILL_PAGE_SIZE) {
      const page = await this.subscriptions.find({
        where: {
          status: SubscriptionStatus.PAST_DUE,
          auto_renew: true,
          deleted_at: IsNull(),
        },
        relations: { tenant: true, plan: true },
        order: { id: 'ASC' },
        skip: offset,
        take: RENEWAL_BILL_PAGE_SIZE,
      });
      if (page.length === 0) break;
      result.due += page.length;

      for (const subscription of page) {
        const outcome = await this.processOne(subscription).catch((err) => {
          this.logger.warn(
            `renewalBill: subscription ${subscription.id} failed unexpectedly: ${(err as Error)?.message}`,
          );
          return 'skipped' as const;
        });
        if (outcome === 'settled' || outcome === 'declined')
          result.attempted += 1;
        result[outcome] += 1;
      }
      if (page.length < RENEWAL_BILL_PAGE_SIZE) break;
    }

    this.logger.log(
      `renewalBill: ${result.due} PAST_DUE due, ${result.attempted} attempted ` +
        `(${result.settled} settled, ${result.declined} declined), ${result.skipped} skipped`,
    );
    return result;
  }

  /**
   * One subscription's turn. Returns which bucket it landed in — 'settled'
   * and 'declined' are both attempts (the caller also counts them toward
   * `result.attempted`); 'skipped' never was one (nothing due yet, a
   * terminal invoice, or a race lost to a concurrent attempt).
   */
  private async processOne(
    subscription: Subscription,
  ): Promise<'settled' | 'declined' | 'skipped'> {
    const invoice = await this.findOrCreatePeriodInvoice(subscription);
    if (!invoice) return 'skipped'; // terminal invoice already exists for this period

    const now = new Date();
    const isFirstAttempt = invoice.retry_count === 0 && !invoice.next_retry_at;
    const retryDue = invoice.next_retry_at && invoice.next_retry_at <= now;
    if (!isFirstAttempt && !retryDue) return 'skipped'; // not due yet

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_ATTEMPTED,
      userId: undefined,
      entityType: 'subscription',
      entityId: subscription.id,
      tenantId: subscription.tenant?.id,
      after: { invoiceId: invoice.id, retryCount: invoice.retry_count },
    });

    try {
      const paid = await this.billing.payInvoice(
        subscription.tenant!.id,
        invoice.id,
      );
      await this.onSettled(subscription, paid);
      return 'settled';
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.CONFLICT) {
        // Claimed by a concurrent attempt (or already PAID) — not a
        // decline of ours to record; the other attempt owns the outcome.
        return 'skipped';
      }
      await this.onDeclined(subscription, invoice);
      return 'declined';
    }
  }

  /**
   * Finds the invoice already covering the subscription's CURRENT period, or
   * creates it — race-safe via the DB's own `UQ_sub_invoice_period`
   * constraint (same insert-or-fetch shape as `TransactionService
   * .recordWebhookOnce`), not an application-level check-then-insert.
   * Returns null when the period's invoice is already terminal (PAID, VOID,
   * REFUNDED) — nothing left for this service to do.
   */
  private async findOrCreatePeriodInvoice(
    subscription: Subscription,
  ): Promise<SubscriptionInvoice | null> {
    const existing = await this.invoices.findOne({
      where: {
        subscription_id: subscription.id,
        period_start: subscription.starts_at,
      },
    });
    if (existing) {
      if (
        existing.status === InvoiceStatus.PAID ||
        existing.status === InvoiceStatus.VOID ||
        existing.status === InvoiceStatus.REFUNDED
      ) {
        return null;
      }
      return existing;
    }

    const currency = await this.platformSettings.getTyped<string>(
      SettingKey.DEFAULT_CURRENCY,
    );
    try {
      return await this.billing.generateInvoice(
        subscription.tenant!.id,
        subscription.id,
        Number(subscription.plan!.price),
        subscription.starts_at,
        subscription.ends_at,
        currency,
      );
    } catch (err) {
      // Lost the race to a concurrent sweep — fetch what it created.
      if ((err as { code?: string })?.code === '23505') {
        const winner = await this.invoices.findOne({
          where: {
            subscription_id: subscription.id,
            period_start: subscription.starts_at,
          },
        });
        return winner &&
          winner.status !== InvoiceStatus.PAID &&
          winner.status !== InvoiceStatus.VOID &&
          winner.status !== InvoiceStatus.REFUNDED
          ? winner
          : null;
      }
      throw err;
    }
  }

  /** A successful charge revives the subscription: ACTIVE, period advanced,
   *  grace cleared. Never touched by the failure path. */
  private async onSettled(
    subscription: Subscription,
    invoice: SubscriptionInvoice,
  ): Promise<void> {
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.starts_at = subscription.ends_at;
    subscription.ends_at = computeNextPeriodEnd(
      subscription.starts_at,
      subscription.plan!,
    );
    subscription.grace_started_at = null;
    subscription.grace_expired_at = null;
    await this.subscriptions.save(subscription);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_SETTLED,
      userId: undefined,
      entityType: 'subscription',
      entityId: subscription.id,
      tenantId: subscription.tenant?.id,
      after: {
        invoiceId: invoice.id,
        providerReference: invoice.provider_reference,
        newEndsAt: subscription.ends_at.toISOString(),
      },
    });

    if (subscription.tenant?.contact_email) {
      this.email.sendInvoice({
        to: subscription.tenant.contact_email,
        amount: invoice.amount,
        planName: subscription.plan?.name,
        tenantId: subscription.tenant.id,
        invoiceNumber: invoice.id,
      });
    }
  }

  /**
   * A decline never touches `Subscription.status` — only the INVOICE's own
   * retry bookkeeping. The +1/+3/+5 day schedule stops (no further retry
   * scheduled) once the next slot would fall at or past grace expiry;
   * `SubscriptionsProcessor.transitionGraceExpired` handles what happens
   * next entirely on its own.
   */
  private async onDeclined(
    subscription: Subscription,
    invoice: SubscriptionInvoice,
  ): Promise<void> {
    const fresh = await this.invoices.findOne({ where: { id: invoice.id } });
    if (!fresh) return; // invoice vanished under us — nothing left to bump

    const nextRetryCount = fresh.retry_count + 1;
    const delayDays =
      RETRY_SCHEDULE_DAYS[
        Math.min(nextRetryCount - 1, RETRY_SCHEDULE_DAYS.length - 1)
      ];
    const candidateRetryAt = new Date(Date.now() + delayDays * 86_400_000);

    const graceEndsAt = subscription.grace_started_at
      ? new Date(
          subscription.grace_started_at.getTime() +
            this.graceDurationDays() * 86_400_000,
        )
      : null;
    const withinGrace =
      nextRetryCount <= RETRY_SCHEDULE_DAYS.length &&
      (!graceEndsAt || candidateRetryAt < graceEndsAt);

    fresh.retry_count = nextRetryCount;
    fresh.next_retry_at = withinGrace ? candidateRetryAt : null;
    await this.invoices.save(fresh);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_DECLINED,
      userId: undefined,
      entityType: 'subscription',
      entityId: subscription.id,
      tenantId: subscription.tenant?.id,
      after: {
        invoiceId: fresh.id,
        retryCount: fresh.retry_count,
        nextRetryAt: fresh.next_retry_at?.toISOString() ?? null,
        failureClass: fresh.failure_class,
      },
    });

    if (subscription.tenant?.contact_email) {
      this.email.sendPaymentFailed({
        to: subscription.tenant.contact_email,
        amount: fresh.amount,
        reason: fresh.failure_reason ?? undefined,
        tenantId: subscription.tenant.id,
        paymentId: fresh.id,
      });
    }
  }
}
