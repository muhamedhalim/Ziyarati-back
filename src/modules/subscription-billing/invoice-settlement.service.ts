import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import {
  InvoiceStatus,
  SubscriptionInvoiceKind,
  SubscriptionStatus,
} from '../../entities/enums';
import { EmailService } from '../email/email.service';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import {
  SubscriptionActivatedEvent,
  SubscriptionPlanChangedEvent,
  SubscriptionReactivatedEvent,
} from '../../events/subscription.events';

import { AccessControlService } from './access-control.service';
import { PaymentMethodService } from './payment-method.service';
import { computeNextPeriodEnd } from './subscription-period.util';
import type { SavedPaymentMethodInfo } from './payment/payment-provider.interface';

/** Statuses an invoice can still be paid from — the same set `payInvoice` may claim. */
const PAYABLE_STATUSES: readonly InvoiceStatus[] = [
  InvoiceStatus.OPEN,
  InvoiceStatus.DRAFT,
  InvoiceStatus.UNCOLLECTIBLE,
];

export interface SettleEvidence {
  /** Which door the proof of payment came through (audit only). */
  source: 'charge' | 'checkout_verify' | 'webhook' | 'reconciliation';
  /** Gateway that took the money (`tap`, `stub`, …). */
  provider: string;
  /** The gateway's charge id. */
  reference: string;
  /** Dedupe key of the webhook delivery, when that is the door. */
  webhookEventId?: string | null;
  /** Captured amount in the domain's cents (×100) — checked against the invoice. */
  capturedMinorUnits?: number;
  capturedCurrency?: string;
  /** The card this payment saved (hosted checkout with save-card). */
  savedPaymentMethod?: SavedPaymentMethodInfo;
  /** The saved card that was CHARGED (merchant-initiated renewal). */
  paymentMethodId?: string;
}

export type SettleOutcome =
  /** Invoice is PAID now and the subscription lifecycle was applied (or the invoice is legacy: nothing to apply). */
  | 'settled'
  /** Invoice is PAID now (money moved) but the subscription could not take it — operator decides. */
  | 'settled_unapplied'
  /** Already PAID, or this exact webhook delivery was seen: nothing to do. */
  | 'already_paid'
  /** NOT booked: invoice missing/void/refunded, or the captured amount/currency does not match. */
  | 'rejected';

export interface SettleResult {
  outcome: SettleOutcome;
  /** Why it was rejected / not applied. For logs and audit — never shown to a user. */
  reason?: string;
  invoice: SubscriptionInvoice | null;
}

/** What the transaction decided, handed to the after-commit step. */
interface Applied {
  kind: string | null;
  tenantId: string;
  subscriptionId: string;
  planId: string;
  /** The subscription row changed (access cache must be dropped). */
  changed: boolean;
}

/**
 * THE one place a subscription invoice becomes PAID (Tap migration, plan §5.2).
 *
 * Before this existed three code paths each marked an invoice PAID by hand —
 * `BillingService.payInvoice`, the webhook, and the reconciliation sweep — and
 * only `RenewalService` ever advanced the SUBSCRIPTION. A webhook- or
 * reconcile-settled invoice therefore left the clinic's subscription exactly as
 * it was. Now every door calls this, and the invoice + the subscription move in
 * ONE transaction.
 *
 * What settling does, by what the invoice BUYS (`invoice.kind`):
 *   INITIAL / REACTIVATION  PENDING_PAYMENT (or a lapsed one) -> ACTIVE, period counted from the payment
 *   UPGRADE                 plan switches to the one paid for, ACTIVE, fresh period from the payment
 *   RENEWAL                 the next period, plan = what the invoice billed, scheduled downgrade applied
 *   NULL (legacy)           only marks the invoice PAID, as it always did
 *
 * Idempotent and safe under replay: the invoice row is locked, an invoice that
 * is already PAID is returned untouched, and the same webhook delivery is
 * recognised by its dedupe key. A captured payment that CANNOT be applied
 * (invoice void/refunded, subscription cancelled/suspended, a renewal invoice
 * for a period the subscription has moved past) is still recorded and raises an
 * ALERT — money moved, and silently dropping or silently re-activating would
 * both be wrong.
 *
 * Lock order: invoice, then subscription. Both are locked WITHOUT joins (a
 * `FOR UPDATE` over an outer-joined relation fails on Postgres); relations are
 * loaded in a second, unlocked read.
 */
@Injectable()
export class InvoiceSettlementService {
  private readonly logger = new Logger('InvoiceSettlementService');

  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(SubscriptionPlan)
    private readonly plans: Repository<SubscriptionPlan>,
    private readonly dataSource: DataSource,
    private readonly methods: PaymentMethodService,
    private readonly access: AccessControlService,
    private readonly emitter: EventEmitter2,
    private readonly audit: PlatformAdminAuditService,
    private readonly email: EmailService,
  ) {}

  async settleInvoicePaid(
    invoiceId: string,
    evidence: SettleEvidence,
  ): Promise<SettleResult> {
    const { result, applied } = await this.dataSource.transaction((manager) =>
      this.settleInTransaction(manager, invoiceId, evidence),
    );

    if (
      result.outcome === 'settled' ||
      result.outcome === 'settled_unapplied'
    ) {
      await this.afterCommit(result, applied, evidence);
    }
    return result;
  }

  // ───────────────────────────── transaction ───────────────────────────── //

  private async settleInTransaction(
    manager: EntityManager,
    invoiceId: string,
    evidence: SettleEvidence,
  ): Promise<{ result: SettleResult; applied: Applied | null }> {
    const invRepo = manager.getRepository(SubscriptionInvoice);
    const inv = await invRepo.findOne({
      where: { id: invoiceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!inv) {
      return {
        result: {
          outcome: 'rejected',
          reason: 'invoice_not_found',
          invoice: null,
        },
        applied: null,
      };
    }

    // The same webhook delivery again — recognised by its dedupe key.
    if (
      evidence.webhookEventId &&
      inv.webhook_event_id === evidence.webhookEventId
    ) {
      return {
        result: { outcome: 'already_paid', invoice: inv },
        applied: null,
      };
    }

    if (inv.status === InvoiceStatus.PAID) {
      if (
        inv.provider_reference &&
        inv.provider_reference !== evidence.reference
      ) {
        // A SECOND charge captured for an already-paid invoice. Nothing is
        // refunded automatically (no auto money movement): a human decides.
        this.logger.error(
          `ALERT: duplicate capture — invoice ${inv.id} is already PAID by ${inv.provider_reference} but ${evidence.provider} charge ${evidence.reference} was also captured; refund the duplicate`,
        );
      }
      await this.rememberDelivery(invRepo, inv, evidence);
      return {
        result: { outcome: 'already_paid', invoice: inv },
        applied: null,
      };
    }

    if (!PAYABLE_STATUSES.includes(inv.status)) {
      this.logger.error(
        `ALERT: ${evidence.provider} charge ${evidence.reference} was captured for invoice ${inv.id} which is ${inv.status} — not booked; refund it`,
      );
      await this.rememberDelivery(invRepo, inv, evidence);
      return {
        result: {
          outcome: 'rejected',
          reason: `invoice_${inv.status.toLowerCase()}`,
          invoice: inv,
        },
        applied: null,
      };
    }

    const mismatch = this.amountMismatch(inv, evidence);
    if (mismatch) {
      this.logger.error(
        `Invoice ${inv.id}: ${evidence.provider} captured ${mismatch} — NOT booked, left for manual review`,
      );
      return {
        result: {
          outcome: 'rejected',
          reason: 'amount_mismatch',
          invoice: inv,
        },
        applied: null,
      };
    }

    const now = new Date();
    inv.status = InvoiceStatus.PAID;
    inv.paid_at = now;
    inv.provider_reference = evidence.reference;
    inv.provider = evidence.provider;
    inv.failure_reason = null;
    inv.failure_class = null;
    inv.charge_started_at = null;
    inv.checkout_started_at = null;
    inv.next_retry_at = null;
    if (evidence.webhookEventId) inv.webhook_event_id = evidence.webhookEventId;
    if (evidence.paymentMethodId)
      inv.payment_method_id = evidence.paymentMethodId;

    const lifecycle = await this.applyLifecycle(manager, inv, now);

    if (evidence.savedPaymentMethod) {
      const method = await this.methods.upsertDefault(
        manager,
        inv.tenant_id,
        evidence.savedPaymentMethod,
        inv.id,
      );
      if (method) inv.payment_method_id = method.id;
    }

    const persisted = await invRepo.save(inv);
    return {
      result: {
        outcome: lifecycle.unappliedReason ? 'settled_unapplied' : 'settled',
        reason: lifecycle.unappliedReason,
        invoice: persisted,
      },
      applied: lifecycle.applied,
    };
  }

  /** Remembers the webhook delivery on a terminal invoice so a replay short-circuits cheaply. */
  private async rememberDelivery(
    repo: Repository<SubscriptionInvoice>,
    inv: SubscriptionInvoice,
    evidence: SettleEvidence,
  ): Promise<void> {
    if (
      !evidence.webhookEventId ||
      inv.webhook_event_id === evidence.webhookEventId
    ) {
      return;
    }
    inv.webhook_event_id = evidence.webhookEventId;
    await repo.save(inv);
  }

  /** Describes a mismatch (for the log) or returns null when the capture matches the invoice. */
  private amountMismatch(
    inv: SubscriptionInvoice,
    evidence: SettleEvidence,
  ): string | null {
    if (evidence.capturedMinorUnits != null) {
      const expected = Math.round(Number(inv.amount) * 100);
      if (evidence.capturedMinorUnits !== expected) {
        return `${evidence.capturedMinorUnits} minor units, expected ${expected}`;
      }
    }
    if (
      evidence.capturedCurrency &&
      evidence.capturedCurrency.toUpperCase() !== inv.currency.toUpperCase()
    ) {
      return `currency ${evidence.capturedCurrency}, expected ${inv.currency}`;
    }
    return null;
  }

  // ───────────────────────────── lifecycle ───────────────────────────── //

  private async applyLifecycle(
    manager: EntityManager,
    inv: SubscriptionInvoice,
    paidAt: Date,
  ): Promise<{ applied: Applied | null; unappliedReason?: string }> {
    // A legacy invoice (issued before `kind` existed) only ever marked itself PAID.
    if (!inv.kind) return { applied: null };

    const subRepo = manager.getRepository(Subscription);
    const locked = await subRepo.findOne({
      where: { id: inv.subscription_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!locked)
      return { applied: null, unappliedReason: 'subscription_missing' };

    // Relations in a SECOND, unlocked read — never LEFT JOIN under FOR UPDATE.
    const sub = await subRepo.findOne({
      where: { id: locked.id },
      relations: { plan: true, pending_plan: true },
    });
    if (!sub || !sub.plan) {
      return { applied: null, unappliedReason: 'subscription_missing' };
    }

    const targetId = inv.target_plan_id ?? sub.plan.id;
    const plan =
      targetId === sub.plan.id
        ? sub.plan
        : await manager
            .getRepository(SubscriptionPlan)
            .findOne({ where: { id: targetId } });
    if (!plan) return { applied: null, unappliedReason: 'target_plan_missing' };

    const status = sub.status;
    const unapplied = (reason: string) => ({
      applied: {
        kind: inv.kind ?? null,
        tenantId: inv.tenant_id,
        subscriptionId: sub.id,
        planId: sub.plan.id,
        changed: false,
      },
      unappliedReason: reason,
    });

    switch (inv.kind) {
      case SubscriptionInvoiceKind.INITIAL:
      case SubscriptionInvoiceKind.REACTIVATION: {
        const lapsed =
          inv.kind === SubscriptionInvoiceKind.REACTIVATION &&
          (status === SubscriptionStatus.PAST_DUE ||
            status === SubscriptionStatus.GRACE_EXPIRED);
        if (status !== SubscriptionStatus.PENDING_PAYMENT && !lapsed) {
          return unapplied(`subscription_${status.toLowerCase()}`);
        }
        this.startFreshPeriod(sub, plan, paidAt, inv);
        if (inv.kind === SubscriptionInvoiceKind.REACTIVATION) {
          sub.auto_renew = true;
        }
        break;
      }
      case SubscriptionInvoiceKind.UPGRADE: {
        const allowed: SubscriptionStatus[] = [
          SubscriptionStatus.TRIAL,
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.PAST_DUE,
          SubscriptionStatus.GRACE_EXPIRED,
        ];
        if (!allowed.includes(status)) {
          return unapplied(`subscription_${status.toLowerCase()}`);
        }
        this.startFreshPeriod(sub, plan, paidAt, inv);
        break;
      }
      case SubscriptionInvoiceKind.RENEWAL: {
        const allowed: SubscriptionStatus[] = [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.PAST_DUE,
          SubscriptionStatus.GRACE_EXPIRED,
        ];
        if (!allowed.includes(status)) {
          return unapplied(`subscription_${status.toLowerCase()}`);
        }
        // The invoice bills the period that STARTS where the subscription's
        // paid period ends. If the subscription has moved on since, applying it
        // would advance the clinic twice for one payment.
        if (inv.period_start.getTime() !== sub.ends_at.getTime()) {
          return unapplied('renewal_period_stale');
        }
        sub.plan = plan;
        if (sub.pending_plan?.id === plan.id) sub.pending_plan = null;
        sub.status = SubscriptionStatus.ACTIVE;
        sub.starts_at = sub.ends_at;
        sub.ends_at = computeNextPeriodEnd(sub.starts_at, plan);
        sub.grace_started_at = null;
        sub.grace_expired_at = null;
        inv.period_end = sub.ends_at;
        break;
      }
      default:
        // An unknown kind from a newer deploy: record the payment, apply nothing.
        return unapplied('unknown_kind');
    }

    await subRepo.save(sub);
    return {
      applied: {
        kind: inv.kind,
        tenantId: inv.tenant_id,
        subscriptionId: sub.id,
        planId: plan.id,
        changed: true,
      },
    };
  }

  /** A fresh, full period counted from the payment (no proration — decision D4). */
  private startFreshPeriod(
    sub: Subscription,
    plan: SubscriptionPlan,
    paidAt: Date,
    inv: SubscriptionInvoice,
  ): void {
    sub.plan = plan;
    sub.status = SubscriptionStatus.ACTIVE;
    sub.starts_at = paidAt;
    sub.ends_at = computeNextPeriodEnd(paidAt, plan);
    sub.grace_started_at = null;
    sub.grace_expired_at = null;
    // Any scheduled downgrade is moot once the clinic has just paid for a plan.
    sub.pending_plan = null;
    // The invoice covers the period the payment actually started.
    inv.period_start = sub.starts_at;
    inv.period_end = sub.ends_at;
  }

  // ──────────────────────────── after commit ──────────────────────────── //

  /**
   * Cache invalidation, events, audit and the receipt e-mail. Best-effort and
   * OUTSIDE the transaction: the invoice and subscription are already durable,
   * and none of this may roll them back. (The plan's durable outbox for these was
   * deliberately not built — they are informational; see the Phase 3 record.)
   */
  private async afterCommit(
    result: SettleResult,
    applied: Applied | null,
    evidence: SettleEvidence,
  ): Promise<void> {
    const invoice = result.invoice;
    if (!invoice) return;

    try {
      if (applied?.changed) this.access.invalidate(applied.tenantId);

      if (result.outcome === 'settled_unapplied') {
        this.logger.error(
          `ALERT: invoice ${invoice.id} (${invoice.kind}) was PAID via ${evidence.provider} ${evidence.reference} but could not be applied (${result.reason}) — review / refund`,
        );
        await this.audit.record({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_PAYMENT_UNAPPLIED,
          userId: undefined,
          entityType: 'subscription_invoice',
          entityId: invoice.id,
          tenantId: invoice.tenant_id,
          after: { reason: result.reason, source: evidence.source },
        });
        return;
      }

      if (applied?.changed) this.emitDomainEvent(applied, invoice);

      await this.audit.record({
        action:
          invoice.kind === SubscriptionInvoiceKind.RENEWAL
            ? PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_SETTLED
            : PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_PAYMENT_SETTLED,
        userId: undefined,
        entityType: 'subscription_invoice',
        entityId: invoice.id,
        tenantId: invoice.tenant_id,
        after: {
          kind: invoice.kind ?? 'LEGACY',
          source: evidence.source,
          providerReference: invoice.provider_reference,
        },
      });

      await this.sendReceipt(invoice);
    } catch (err) {
      this.logger.warn(
        `post-settle effects failed for invoice ${invoice.id}: ${(err as Error)?.message}`,
      );
    }
  }

  private emitDomainEvent(
    applied: Applied,
    invoice: SubscriptionInvoice,
  ): void {
    switch (invoice.kind) {
      case SubscriptionInvoiceKind.INITIAL:
        this.emitter.emit(
          SubscriptionActivatedEvent.eventName,
          new SubscriptionActivatedEvent(
            applied.tenantId,
            applied.subscriptionId,
            applied.planId,
          ),
        );
        break;
      case SubscriptionInvoiceKind.REACTIVATION:
        this.emitter.emit(
          SubscriptionReactivatedEvent.eventName,
          new SubscriptionReactivatedEvent(
            applied.tenantId,
            applied.subscriptionId,
          ),
        );
        break;
      case SubscriptionInvoiceKind.UPGRADE:
        this.emitter.emit(
          SubscriptionPlanChangedEvent.eventName,
          new SubscriptionPlanChangedEvent(
            applied.tenantId,
            applied.subscriptionId,
            applied.planId,
          ),
        );
        break;
      default:
        break; // RENEWAL: no domain event today (unchanged)
    }
  }

  private async sendReceipt(invoice: SubscriptionInvoice): Promise<void> {
    const tenant = await this.tenants.findOne({
      where: { id: invoice.tenant_id },
    });
    if (!tenant?.contact_email) return;
    const plan = invoice.target_plan_id
      ? await this.plans.findOne({ where: { id: invoice.target_plan_id } })
      : null;
    this.email.sendInvoice({
      to: tenant.contact_email,
      amount: invoice.amount,
      planName: plan?.name,
      tenantId: tenant.id,
      invoiceNumber: invoice.id,
    });
  }
}
