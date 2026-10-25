import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import {
  InvoiceStatus,
  SubscriptionInvoiceKind,
  SubscriptionStatus,
} from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { EmailService } from '../email/email.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';

import { AccessControlService } from './access-control.service';
import { BillingService } from './billing.service';
import { computeNextPeriodEnd } from './subscription-period.util';
import { resolveGraceDays } from './subscription-status';

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
  /** The provider accepted the charge but could not say yet; the webhook / reconcile sweep settles it. */
  pending: number;
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
 * is exactly what T080 says not to do. A SUCCESSFUL charge revives the
 * subscription (PAST_DUE → ACTIVE, period advanced) — but that now happens in
 * ONE place, `InvoiceSettlementService`, which every payment path (this job,
 * the hosted checkout, the webhook, the reconciliation sweep) goes through;
 * this service no longer advances a subscription itself. Every failure path is
 * a no-op on `Subscription.status`, left entirely to the existing sweep.
 *
 * Consequence worth stating plainly: because `renewalCheck` (02:00 UTC) and
 * `renewalBill` (02:15 UTC) are two different cron ticks on the SAME queue
 * (T024), a HEALTHY renewal still passes through a brief (~15 minute)
 * PAST_DUE state before this service revives it the same night — not a bug,
 * a direct consequence of not reimplementing the transition here.
 *
 * THE PERIOD IT BILLS (Tap migration fix). The renewal invoice covers the NEXT
 * period — it starts where the paid period ENDS (`subscription.ends_at`) — and
 * is priced from the plan that period will run on (`pending_plan ?? plan`, so a
 * scheduled downgrade is what gets billed). It used to be keyed on the period
 * that had just ended (`starts_at`), which the subscription's own first invoice
 * already owns: the first renewal of a paid subscription found that invoice
 * PAID and was skipped forever, so the subscription drifted to GRACE_EXPIRED.
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
    // FIN-S4: a free-plan extension changes the subscription row, so the access
    // cache must drop. Optional so a unit that never extends one need not supply it.
    @Optional() private readonly access?: AccessControlService,
  ) {}

  private graceDurationDays(): number {
    return resolveGraceDays(this.config);
  }

  /**
   * The daily pass: every PAST_DUE, auto-renewing subscription either gets
   * its first charge attempt for the next period, or a due retry.
   */
  async processDueBills(): Promise<RenewalBillResult> {
    const result: RenewalBillResult = {
      due: 0,
      attempted: 0,
      settled: 0,
      declined: 0,
      pending: 0,
      skipped: 0,
    };

    for (let offset = 0; ; offset += RENEWAL_BILL_PAGE_SIZE) {
      const page = await this.subscriptions.find({
        where: {
          status: SubscriptionStatus.PAST_DUE,
          auto_renew: true,
          deleted_at: IsNull(),
        },
        relations: { tenant: true, plan: true, pending_plan: true },
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
        if (
          outcome === 'settled' ||
          outcome === 'declined' ||
          outcome === 'pending'
        ) {
          result.attempted += 1;
        }
        result[outcome] += 1;
      }
      if (page.length < RENEWAL_BILL_PAGE_SIZE) break;
    }

    this.logger.log(
      `renewalBill: ${result.due} PAST_DUE due, ${result.attempted} attempted ` +
        `(${result.settled} settled, ${result.declined} declined, ${result.pending} pending), ${result.skipped} skipped`,
    );
    return result;
  }

  /**
   * One subscription's turn. Returns which bucket it landed in — 'settled',
   * 'declined' and 'pending' are all attempts (the caller also counts them
   * toward `result.attempted`); 'skipped' never was one (nothing due yet, a
   * terminal invoice, a checkout the clinic has open, or a race lost to a
   * concurrent attempt).
   */
  private async processOne(
    subscription: Subscription,
  ): Promise<'settled' | 'declined' | 'pending' | 'skipped'> {
    // FIN-S4: a plan that costs nothing has nothing to charge. Issuing a 0.00
    // invoice only produced failed-payment mail and a slide into GRACE_EXPIRED.
    const billedPlan = subscription.pending_plan ?? subscription.plan;
    if (billedPlan && !(Number(billedPlan.price) > 0)) {
      return (await this.extendFreePeriod(subscription, billedPlan))
        ? 'settled'
        : 'skipped';
    }

    const invoice = await this.findOrCreatePeriodInvoice(subscription);
    if (!invoice) return 'skipped'; // terminal invoice already exists for this period

    const now = new Date();
    const isFirstAttempt = invoice.retry_count === 0 && !invoice.next_retry_at;
    const retryDue = invoice.next_retry_at && invoice.next_retry_at <= now;
    if (!isFirstAttempt && !retryDue) return 'skipped'; // not due yet

    // The clinic is paying this very invoice by hand right now (hosted checkout
    // open, or a charge already claimed): standing down is what keeps one
    // obligation from being captured twice.
    if (this.billing.isPaymentInFlight(invoice)) return 'skipped';

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
      // PAID = captured and the subscription advanced (by the settle path).
      // Anything else is a charge the provider has not resolved yet: the claim
      // is held and the webhook / reconciliation sweep finishes it.
      return paid.status === InvoiceStatus.PAID ? 'settled' : 'pending';
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
   * FIN-S4 — roll a zero-price subscription into its next period without an
   * invoice. Locked and re-checked (still PAST_DUE, same `ends_at`) so a
   * concurrent sweep or a manual change never advances it twice.
   */
  private async extendFreePeriod(
    seen: Subscription,
    plan: NonNullable<Subscription['plan']>,
  ): Promise<boolean> {
    const extended = await this.subscriptions.manager.transaction(
      async (manager) => {
        const repo = manager.getRepository(Subscription);
        const sub = await repo.findOne({
          where: { id: seen.id },
          relations: { plan: true, pending_plan: true },
          lock: { mode: 'pessimistic_write', tables: ['subscriptions'] },
        });
        if (
          !sub ||
          sub.status !== SubscriptionStatus.PAST_DUE ||
          !sub.auto_renew ||
          sub.ends_at.getTime() !== seen.ends_at.getTime()
        ) {
          return false;
        }
        sub.plan = plan;
        if (sub.pending_plan?.id === plan.id) sub.pending_plan = null;
        sub.status = SubscriptionStatus.ACTIVE;
        sub.starts_at = sub.ends_at;
        sub.ends_at = computeNextPeriodEnd(sub.starts_at, plan);
        sub.grace_started_at = null;
        sub.grace_expired_at = null;
        await repo.save(sub);
        return true;
      },
    );
    if (extended && seen.tenant?.id) this.access?.invalidate(seen.tenant.id);
    return extended;
  }

  /**
   * Finds the invoice already covering the NEXT period, or creates it — race-safe
   * via the DB's own `UQ_sub_invoice_period` constraint (same insert-or-fetch
   * shape as `TransactionService.recordWebhookOnce`), not an application-level
   * check-then-insert. Returns null when that period's invoice is already
   * terminal (PAID, REFUNDED) or another invoice is being paid instead — nothing
   * left for this service to do.
   */
  private async findOrCreatePeriodInvoice(
    subscription: Subscription,
  ): Promise<SubscriptionInvoice | null> {
    const periodStart = subscription.ends_at;
    const existing = await this.findPeriodInvoice(subscription.id, periodStart);
    if (existing) return this.isTerminal(existing) ? null : existing;

    // An unpaid pre-Tap creation invoice, or a stale upgrade quote, still holds
    // the subscription's single OPEN slot. Neither bills the period that is about
    // to start, and nobody is paying them: supersede them so the renewal can issue
    // its own. (An invoice a clinic IS paying right now is never touched.)
    await this.billing.voidSupersededOpenInvoices(
      subscription.id,
      'Superseded by the renewal invoice for the next period',
    );

    // The plan the next period runs on: a scheduled downgrade wins.
    const billedPlan = subscription.pending_plan ?? subscription.plan!;
    const currency = await this.platformSettings.getTyped<string>(
      SettingKey.DEFAULT_CURRENCY,
    );
    try {
      return await this.billing.generateInvoice(
        subscription.tenant!.id,
        subscription.id,
        Number(billedPlan.price),
        periodStart,
        computeNextPeriodEnd(periodStart, billedPlan),
        currency,
        InvoiceStatus.OPEN,
        {
          kind: SubscriptionInvoiceKind.RENEWAL,
          targetPlanId: billedPlan.id,
          provider: this.billing.providerName,
        },
      );
    } catch (err) {
      // Lost the race to a concurrent sweep — fetch what it created. (The other
      // 23505, a different OPEN invoice a clinic is paying, finds nothing here
      // and is skipped.)
      if ((err as { code?: string })?.code === '23505') {
        const winner = await this.findPeriodInvoice(
          subscription.id,
          periodStart,
        );
        return winner && !this.isTerminal(winner) ? winner : null;
      }
      throw err;
    }
  }

  private findPeriodInvoice(
    subscriptionId: string,
    periodStart: Date,
  ): Promise<SubscriptionInvoice | null> {
    return this.invoices.findOne({
      where: {
        subscription_id: subscriptionId,
        period_start: periodStart,
        status: Not(InvoiceStatus.VOID),
      },
    });
  }

  private isTerminal(invoice: SubscriptionInvoice): boolean {
    return (
      invoice.status === InvoiceStatus.PAID ||
      invoice.status === InvoiceStatus.VOID ||
      invoice.status === InvoiceStatus.REFUNDED
    );
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
    if (fresh.status !== InvoiceStatus.OPEN) return; // paid / voided since: nothing to retry

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

    // FIN-S3: a guarded UPDATE, never a load-then-save of the whole row. A
    // webhook or the sweep may have settled this invoice since it was read, and
    // writing the stale row back would turn a PAID invoice OPEN again (and charge
    // the clinic a second time). Only an invoice still OPEN and still at the retry
    // count we read is touched; anything else means someone else moved it first.
    const bumped = await this.invoices
      .createQueryBuilder()
      .update(SubscriptionInvoice)
      .set({
        retry_count: nextRetryCount,
        next_retry_at: withinGrace ? candidateRetryAt : null,
      })
      .where('id = :id AND status = :open AND retry_count = :seen', {
        id: fresh.id,
        open: InvoiceStatus.OPEN,
        seen: fresh.retry_count,
      })
      .execute();
    if (!bumped.affected) return; // settled / voided / bumped by someone else

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
