import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type RefundResult,
} from './payment/payment-provider.interface';

const toCents = (v: number | string): number => Math.round(Number(v) * 100);

/** A refund still unanswered after this long is asked about by the sweep. */
const IN_FLIGHT_STALE_MS = 10 * 60_000;
/**
 * How long a refund whose provider id we never learned may be RE-SENT. The re-send
 * reuses the attempt's idempotency key, so inside the provider's window (Tap: 24 h)
 * it returns the original refund; past it, it would be a new one — so past this
 * (well inside that window) it is left for an operator.
 */
const REPLAY_WINDOW_MS = 12 * 60 * 60_000;

export interface InvoiceRefundOutcome {
  status: 'refunded' | 'pending';
  invoice: SubscriptionInvoice;
}

/** What a gateway refund event tells us about a subscription invoice (built by the payments module). */
export interface GatewayInvoiceRefundEvent {
  /** The provider refund id. */
  reference: string;
  outcome: 'succeeded' | 'failed' | 'pending' | 'unknown';
  amountMinorUnits?: number;
}

export interface InvoiceRefundSweepSummary {
  scanned: number;
  refunded: number;
  failed: number;
  stillPending: number;
}

/**
 * The PLATFORM's refund of a subscription invoice it collected (super admin).
 *
 * A subscription payment is platform revenue, so refunding one is the platform's
 * decision, not the clinic's: there is no tenant-facing route. The refund is always
 * the FULL invoice amount (an invoice is one billing period; there is no partial
 * period to represent), and it does NOT change the subscription's status — that
 * would be a new business rule. It only moves the invoice PAID → REFUNDED.
 *
 * The same three-phase shape as booking refunds, for the same reasons:
 *   1. an atomic CLAIM (one conditional UPDATE) so two admins cannot both refund;
 *   2. the provider call OUTSIDE any lock;
 *   3. the outcome applied under the invoice row lock.
 * And the same honesty about an asynchronous provider: `pending` and `unknown` keep
 * the claim (the invoice stays PAID, in flight) and the provider's webhook or the
 * sweep completes it — they are never a failure and never a success.
 *
 * In flight = `refund_requested_at` set and `refunded_at` not. A definitive decline
 * clears the claim (a retry is a NEW attempt, with its own idempotency key).
 */
@Injectable()
export class SubscriptionInvoiceRefundService {
  private readonly logger = new Logger('SubscriptionInvoiceRefundService');

  constructor(
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly dataSource: DataSource,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  // ───────────────────────────── the admin's request ───────────────────────────── //

  async request(
    invoiceId: string,
    actorId: string | undefined,
    reason?: string,
  ): Promise<InvoiceRefundOutcome> {
    const trimmed = reason?.trim() || undefined;

    // ── Phase 1: atomic claim ──
    const claimed: Array<{
      refund_attempts: number;
      amount: string;
      currency: string;
      tenant_id: string;
      provider_reference: string;
    }> = await this.dataSource
      .query(
        `UPDATE subscription_invoices
            SET refund_requested_at = now(),
                refund_attempts = refund_attempts + 1,
                refund_reason = COALESCE($2, refund_reason)
          WHERE id = $1 AND status = 'PAID' AND refund_requested_at IS NULL
            AND provider_reference IS NOT NULL
          RETURNING refund_attempts, amount, currency, tenant_id, provider_reference`,
        [invoiceId, trimmed ?? null],
      )
      .then((res) => (Array.isArray(res?.[0]) ? res[0] : res));

    if (claimed.length === 0) return this.explainNoClaim(invoiceId);
    const c = claimed[0];

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_REFUND_REQUESTED,
      userId: actorId,
      entityType: 'subscription_invoice',
      entityId: invoiceId,
      tenantId: c.tenant_id,
      after: {
        amount: c.amount,
        currency: c.currency,
        attempt: c.refund_attempts,
        reason: trimmed ?? null,
      },
    });

    // ── Phase 2: the provider call, outside any lock ──
    let result: RefundResult;
    try {
      result = await this.provider.refund({
        tenantId: c.tenant_id,
        invoiceId,
        amount: Number(c.amount),
        currency: c.currency,
        reason: trimmed,
        chargeReference: c.provider_reference,
        attempt: c.refund_attempts,
      });
    } catch (err) {
      // The call may or may not have reached the provider: in flight, never failed.
      this.logger.error(
        `Refund call for invoice ${invoiceId} threw (${(err as Error).message}) — left in flight`,
      );
      result = { success: false, status: 'unknown' };
    }

    // ── Phase 3: apply ──
    return this.apply(invoiceId, c.tenant_id, actorId, result);
  }

  /** Why nothing was claimed, as the caller needs to hear it. */
  private async explainNoClaim(
    invoiceId: string,
  ): Promise<InvoiceRefundOutcome> {
    const invoice = await this.invoices.findOne({ where: { id: invoiceId } });
    if (!invoice) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Invoice not found' });
    }
    if (invoice.status === InvoiceStatus.REFUNDED) {
      return { status: 'refunded', invoice }; // idempotent
    }
    if (invoice.status === InvoiceStatus.PAID && invoice.refund_requested_at) {
      return { status: 'pending', invoice }; // already in flight: do not start a second
    }
    if (invoice.status !== InvoiceStatus.PAID) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only a paid invoice can be refunded (status: ${invoice.status})`,
      });
    }
    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message: 'This invoice has no payment reference to refund',
    });
  }

  /** Book a provider answer against the invoice (also used by the sweep's replay). */
  private async apply(
    invoiceId: string,
    tenantId: string,
    actorId: string | undefined,
    result: RefundResult,
  ): Promise<InvoiceRefundOutcome> {
    const status = result.status ?? (result.success ? 'succeeded' : 'failed');

    if (status === 'failed') {
      // Definitive: clear the claim so a retry (a NEW attempt) is possible.
      await this.dataSource.query(
        `UPDATE subscription_invoices
            SET refund_requested_at = NULL, refund_reference = NULL
          WHERE id = $1 AND status = 'PAID' AND refunded_at IS NULL`,
        [invoiceId],
      );
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_REFUND_FAILED,
        userId: actorId,
        entityType: 'subscription_invoice',
        entityId: invoiceId,
        tenantId,
        after: {
          reason: result.failureReason ?? null,
          code: result.failureCode ?? null,
        },
      });
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Refund was declined by the payment gateway',
        // The provider's own wording / code: logs only, never the client.
        internalContext: {
          reason: result.failureReason,
          code: result.failureCode,
        },
      });
    }

    if (status === 'succeeded') {
      const invoice = await this.markRefunded(invoiceId, result.reference);
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_REFUNDED,
        userId: actorId,
        entityType: 'subscription_invoice',
        entityId: invoiceId,
        tenantId,
        after: { reference: result.reference ?? null },
      });
      return { status: 'refunded', invoice };
    }

    // pending | unknown: keep the claim; remember the provider's id once we have it.
    if (result.reference)
      await this.rememberReference(invoiceId, result.reference);
    const invoice = await this.invoices.findOneOrFail({
      where: { id: invoiceId },
    });
    return { status: 'pending', invoice };
  }

  private async markRefunded(
    invoiceId: string,
    reference: string | undefined,
  ): Promise<SubscriptionInvoice> {
    await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(SubscriptionInvoice);
      const locked = await repo.findOne({
        where: { id: invoiceId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.status !== InvoiceStatus.PAID) return; // already REFUNDED (or moved on)
      locked.status = InvoiceStatus.REFUNDED;
      locked.refunded_at = new Date();
      locked.refund_requested_at = locked.refund_requested_at ?? new Date();
      if (reference && !locked.refund_reference)
        locked.refund_reference = reference;
      await repo.save(locked);
    });
    return this.invoices.findOneOrFail({ where: { id: invoiceId } });
  }

  private rememberReference(invoiceId: string, reference: string) {
    return this.dataSource.query(
      `UPDATE subscription_invoices SET refund_reference = $2
        WHERE id = $1 AND status = 'PAID' AND refunded_at IS NULL AND refund_reference IS NULL`,
      [invoiceId, reference],
    );
  }

  // ───────────────────────── the gateway's own word (webhook) ───────────────────────── //

  /**
   * A (re-fetched, authenticated) gateway refund for a charge that paid a subscription
   * invoice. Finds the invoice by the charge it was paid with. Returns whether an invoice
   * matched, and — when it matched but could not be booked — why, so the caller can record it.
   *
   * It also books a refund the platform issued OUTSIDE ZiyaraTech (from Tap's dashboard):
   * the money left, so the invoice is REFUNDED. A refund of a DIFFERENT amount than the
   * invoice cannot be represented (an invoice is refunded whole) and is reported, not booked.
   */
  async applyGatewayRefund(
    chargeReference: string,
    event: GatewayInvoiceRefundEvent,
  ): Promise<{
    matched: boolean;
    anomaly?: string;
    invoiceId?: string;
    tenantId?: string;
  }> {
    const invoice = await this.invoices.findOne({
      where: [
        { provider_reference: chargeReference },
        { checkout_charge_id: chargeReference },
      ],
    });
    if (!invoice) return { matched: false };
    const ids = {
      matched: true,
      invoiceId: invoice.id,
      tenantId: invoice.tenant_id,
    };

    if (
      event.amountMinorUnits != null &&
      event.amountMinorUnits !== toCents(invoice.amount)
    ) {
      return { ...ids, anomaly: 'PARTIAL_OR_DIFFERENT_AMOUNT' };
    }

    if (event.outcome === 'succeeded') {
      if (invoice.status === InvoiceStatus.REFUNDED) return ids; // redelivery
      if (invoice.status !== InvoiceStatus.PAID) {
        return { ...ids, anomaly: `INVOICE_NOT_PAID_${invoice.status}` };
      }
      await this.markRefunded(invoice.id, event.reference);
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_REFUNDED,
        entityType: 'subscription_invoice',
        entityId: invoice.id,
        tenantId: invoice.tenant_id,
        after: { reference: event.reference, source: 'gateway_event' },
      });
      return ids;
    }

    if (invoice.status !== InvoiceStatus.PAID || invoice.refunded_at)
      return ids;

    if (event.outcome === 'failed') {
      // Only a refund WE have in flight can be the one that failed.
      if (
        invoice.refund_requested_at &&
        (!invoice.refund_reference ||
          invoice.refund_reference === event.reference)
      ) {
        await this.dataSource.query(
          `UPDATE subscription_invoices SET refund_requested_at = NULL, refund_reference = NULL
            WHERE id = $1 AND status = 'PAID' AND refunded_at IS NULL`,
          [invoice.id],
        );
        await this.audit.record({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_REFUND_FAILED,
          entityType: 'subscription_invoice',
          entityId: invoice.id,
          tenantId: invoice.tenant_id,
          after: { reference: event.reference, source: 'gateway_event' },
        });
      }
      return ids;
    }

    // pending | unknown
    if (invoice.refund_requested_at && !invoice.refund_reference) {
      await this.rememberReference(invoice.id, event.reference);
    }
    return ids;
  }

  // ─────────────────────────────── the sweep ─────────────────────────────── //

  /**
   * Finish refunds the webhook never completed: ask the provider about each refund
   * still in flight (by its id, or — when we never learned it — by re-sending the
   * SAME attempt, which the provider answers with the original refund).
   */
  async sweepInFlight(): Promise<InvoiceRefundSweepSummary> {
    const summary: InvoiceRefundSweepSummary = {
      scanned: 0,
      refunded: 0,
      failed: 0,
      stillPending: 0,
    };
    const stale = new Date(Date.now() - IN_FLIGHT_STALE_MS);
    const rows = await this.invoices
      .createQueryBuilder('i')
      .where("i.status = 'PAID'")
      .andWhere('i.refund_requested_at IS NOT NULL')
      .andWhere('i.refunded_at IS NULL')
      .andWhere('i.refund_requested_at <= :stale', { stale })
      .orderBy('i.refund_requested_at', 'ASC')
      .take(100)
      .getMany();
    summary.scanned = rows.length;

    for (const inv of rows) {
      try {
        const outcome = await this.sweepOne(inv);
        if (outcome === 'refunded') summary.refunded += 1;
        else if (outcome === 'failed') summary.failed += 1;
        else summary.stillPending += 1;
      } catch (err) {
        this.logger.error(
          `Invoice refund sweep failed on ${inv.id}: ${(err as Error).message}`,
        );
        summary.stillPending += 1;
      }
    }
    if (summary.scanned > 0) {
      this.logger.warn(
        `recon(invoice refunds): scanned=${summary.scanned} refunded=${summary.refunded} failed=${summary.failed} stillPending=${summary.stillPending}`,
      );
    }
    return summary;
  }

  private async sweepOne(
    inv: SubscriptionInvoice,
  ): Promise<'refunded' | 'failed' | 'pending'> {
    let result: RefundResult & {
      chargeReference?: string;
      amountMinorUnits?: number;
    };

    if (inv.refund_reference && this.provider.verifyRefund) {
      result = await this.provider.verifyRefund(inv.refund_reference);
      // The refund must be the one we believe it is: this charge, this amount.
      if (
        (result.chargeReference &&
          result.chargeReference !== inv.provider_reference) ||
        (result.amountMinorUnits != null &&
          result.amountMinorUnits !== toCents(inv.amount))
      ) {
        this.logger.error(
          `Invoice ${inv.id}: the provider's refund object does not match this invoice — left in flight for review`,
        );
        return 'pending';
      }
    } else if (!inv.refund_reference) {
      const age = Date.now() - new Date(inv.refund_requested_at!).getTime();
      if (age > REPLAY_WINDOW_MS) {
        this.logger.warn(
          `Invoice ${inv.id} refund has no provider id and is past the replay window — left for manual review`,
        );
        return 'pending';
      }
      // The SAME attempt number ⇒ the same idempotency key ⇒ the original refund.
      result = await this.provider.refund({
        tenantId: inv.tenant_id,
        invoiceId: inv.id,
        amount: Number(inv.amount),
        currency: inv.currency,
        reason: inv.refund_reason ?? undefined,
        chargeReference: inv.provider_reference ?? undefined,
        attempt: inv.refund_attempts,
      });
    } else {
      return 'pending'; // a reference but a provider that cannot look it up
    }

    const status = result.status ?? (result.success ? 'succeeded' : 'failed');
    if (status === 'pending' || status === 'unknown') {
      if (result.reference && !inv.refund_reference) {
        await this.rememberReference(inv.id, result.reference);
      }
      return 'pending';
    }
    try {
      const out = await this.apply(inv.id, inv.tenant_id, undefined, result);
      return out.status === 'refunded' ? 'refunded' : 'pending';
    } catch (err) {
      if (err instanceof AppError) return 'failed'; // a definitive decline, already booked
      throw err;
    }
  }
}
