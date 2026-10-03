import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';

import { ResourcePurchase } from '../../entities/ResourcePricing/ResourcePurchase';
import {
  PAYMENT_EVENT,
  PaymentFailedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';
import { REFUND_EVENT, RefundRecordedEvent } from '../../events/refund.events';

import {
  TenantEntitlementLedgerService,
  LEDGER_REASON,
  LedgerMetric,
} from '../subscription-billing/tenant-entitlement-ledger.service';
import { TenantMetricCreditsService } from '../subscription-billing/tenant-metric-credits.service';
import { UsageMetric } from '../subscription-billing/usage-metric';
import { SELLABLE_KIND, SellableKind } from './sellable-resource.registry';

/**
 * Bridges confirmed payments/refunds to resource-purchase entitlements
 * (Phase 2.3, plan §20) — mirrors `BillingUpgradeEntitlementListener`
 * exactly: events fire ONLY after a verified, deduplicated, COMMITTED
 * payment/refund state change, never from a browser redirect, so this
 * listener may trust them without re-verifying anything itself.
 *
 * Exactly-once: the purchase row is re-locked (`pessimistic_write`) and its
 * status re-checked INSIDE the same transaction that applies the
 * entitlement — a re-delivered webhook finds a terminal status already and
 * no-ops. `TERMINAL_PURCHASE_STATUSES` guards EVERY terminal state, not
 * just `completed` (G14 — the legacy listener's own gap, closed here from
 * the start rather than inherited).
 *
 * Failures are logged, never rethrown — a hiccup here must not fail the
 * payment webhook response.
 *
 * Locking pitfall (found via real-Postgres verification, not present in the
 * `BillingUpgradeEntitlementListener` precedent this mirrors — that listener
 * carries the identical latent bug, never triggered because its table has
 * no real data): `repo.findOne({ where: { payment: { id } }, lock: {...} })`
 * makes TypeORM LEFT JOIN the `payment` relation to evaluate the filter
 * (it is `nullable: true`), and Postgres refuses `FOR UPDATE` on the
 * nullable side of an outer join ("FOR UPDATE cannot be applied to the
 * nullable side of an outer join"). {@link lockPurchaseByPayment} sidesteps
 * this by filtering on the raw `"paymentId"` FK column via query builder —
 * no join to `payments` at all — and only INNER-joins `tenant`, which is
 * `nullable: false` and therefore safe to lock across.
 */
const TERMINAL_PURCHASE_STATUSES = new Set(['completed', 'refunded']);

@Injectable()
export class ResourceEntitlementListener {
  private readonly logger = new Logger('ResourceEntitlementListener');

  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: TenantEntitlementLedgerService,
    private readonly credits: TenantMetricCreditsService,
  ) {}

  private lockPurchaseByPayment(
    manager: EntityManager,
    paymentId: string,
    loadTenant: boolean,
  ): Promise<ResourcePurchase | null> {
    const qb = manager
      .getRepository(ResourcePurchase)
      .createQueryBuilder('purchase')
      .where('purchase."paymentId" = :paymentId', { paymentId })
      .setLock('pessimistic_write');
    if (loadTenant) {
      qb.innerJoinAndSelect('purchase.tenant', 'tenant');
    }
    return qb.getOne();
  }

  /** Fast path: the in-process event. Failures are logged, never rethrown. */
  @OnEvent(PAYMENT_EVENT.SUCCEEDED)
  async onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
    try {
      await this.applyPaid(event.paymentId);
    } catch (err) {
      this.logger.error(
        `Failed to apply entitlement for purchase (payment ${event.paymentId}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Grant the purchase for a CAPTURED payment. Idempotent (see the class doc) and
   * — unlike the event handler above — it THROWS on failure: the durable
   * `payments.outcome` consumer (REL-005) calls this directly and needs the error
   * so the job is retried instead of being marked done.
   */
  async applyPaid(paymentId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const purchase = await this.lockPurchaseByPayment(manager, paymentId, true);
      if (!purchase) return; // not a resource purchase

      // G14 closure: refuse EVERY terminal status, not just 'completed' —
      // a late success after a refund must never re-grant.
      if (TERMINAL_PURCHASE_STATUSES.has(purchase.status)) return;

      const deltaUnits = Number(purchase.delta_units);
      const kind = purchase.kind as SellableKind;

      // The grant is the audit record for BOTH kinds. The DB backstop
      // (UNIQUE(sourcePurchaseId) WHERE direction='grant') makes a
      // concurrent double-application impossible even if this in-process
      // check somehow raced — belt AND suspenders.
      await this.ledger.grant({
        tenantId: purchase.tenant.id,
        metric: purchase.item_key as LedgerMetric,
        kind,
        amountUnits: deltaUnits,
        reason: LEDGER_REASON.PURCHASE,
        sourcePurchaseId: purchase.id,
        manager,
      });

      if (kind === SELLABLE_KIND.CREDIT) {
        // The OPERATIONAL balance for a credit item lives in
        // tenant_metric_credits, not derived from the ledger — the grant
        // above is audit-only for credits.
        await this.credits.credit(
          purchase.tenant.id,
          purchase.item_key as UsageMetric,
          deltaUnits,
          manager,
        );
      }

      purchase.status = 'completed';
      purchase.completed_at = new Date();
      await manager.getRepository(ResourcePurchase).save(purchase);
    });
  }

  /** Fast path: the in-process event. Failures are logged, never rethrown. */
  @OnEvent(PAYMENT_EVENT.FAILED)
  async onPaymentFailed(event: PaymentFailedEvent): Promise<void> {
    try {
      await this.applyFailed(event.paymentId);
    } catch (err) {
      this.logger.error(
        `Failed to record purchase payment failure (payment ${event.paymentId}): ${(err as Error).message}`,
      );
    }
  }

  /** Throwing twin of {@link onPaymentFailed} for the durable consumer. Idempotent. */
  async applyFailed(paymentId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const purchase = await this.lockPurchaseByPayment(manager, paymentId, false);
      if (!purchase) return;
      // Only a purchase still awaiting this payment transitions.
      if (purchase.status !== 'payment_processing') return;

      purchase.status = 'payment_failed';
      purchase.failed_at = new Date();
      await manager.getRepository(ResourcePurchase).save(purchase);
    });
  }

  /**
   * Proportional revoke (plan §14):
   *   targetRevoked = floor(delta_units × refundedCumulativeMinor / total_minor)
   *   newRevoke     = targetRevoked − alreadyRevokedForThisPurchase
   * `newRevoke <= 0` is a no-op — covers both a redelivered event (already
   * accounted for) and a refund on a purchase this listener never granted
   * (still `payment_processing` — nothing to revoke yet; the eventual
   * `onPaymentSucceeded`, guarded by the SAME terminal-status set, will
   * simply never fire for a purchase whose payment ultimately failed).
   */
  /** Fast path: the in-process event. Failures are logged, never rethrown. */
  @OnEvent(REFUND_EVENT.RECORDED)
  async onRefundRecorded(event: RefundRecordedEvent): Promise<void> {
    try {
      await this.applyRefund(
        event.paymentId,
        event.refundId,
        event.refundedCumulativeMinor,
      );
    } catch (err) {
      this.logger.error(
        `Failed to reverse entitlement for refund ${event.refundId} (payment ${event.paymentId}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Revoke in proportion to the CUMULATIVE refunded amount. Idempotent: only the
   * delta against what was already revoked is applied, so a redelivered or
   * out-of-order call converges. THROWS on failure (see {@link applyPaid}).
   */
  async applyRefund(
    paymentId: string,
    refundId: string,
    refundedCumulativeMinorUnits: number,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const purchase = await this.lockPurchaseByPayment(manager, paymentId, true);
      if (!purchase) return; // not a resource-purchase payment

      const deltaUnits = BigInt(purchase.delta_units);
      const totalMinor = BigInt(purchase.total_minor);
      const refundedCumulativeMinor = BigInt(Math.round(refundedCumulativeMinorUnits));

      const targetRevoked = (deltaUnits * refundedCumulativeMinor) / totalMinor; // BigInt division floors
      const alreadyRevoked = BigInt(
        await this.ledger.sumRevokedForPurchase(purchase.id, manager),
      );
      const newRevoke = targetRevoked - alreadyRevoked;
      if (newRevoke <= 0n) return; // nothing new to revoke — redelivery or pre-grant refund

      const kind = purchase.kind as SellableKind;
      let unrecoverableUnits = 0n;

      if (kind === SELLABLE_KIND.CREDIT) {
        // The credit balance may already be partly/fully spent — claw
        // back only what remains, record the rest as unrecoverable
        // (plan §14 "partly used" / "fully used").
        const result = await this.credits.revoke(
          purchase.tenant.id,
          purchase.item_key as UsageMetric,
          Number(newRevoke),
          manager,
        );
        unrecoverableUnits = BigInt(result.unrecoverableUnits);
      }
      // Capacity needs no clawback call of its own — `capacityMap`'s
      // GREATEST(SUM(...), 0) already floors at 0 once the revoke row
      // below is appended; there is no separate balance to touch.

      await this.ledger.revoke({
        tenantId: purchase.tenant.id,
        metric: purchase.item_key as LedgerMetric,
        kind,
        amountUnits: Number(newRevoke),
        unrecoverableUnits: Number(unrecoverableUnits),
        reason: LEDGER_REASON.REFUND,
        sourcePurchaseId: purchase.id,
        sourceRefundId: refundId,
        manager,
      });

      if (refundedCumulativeMinor >= totalMinor && purchase.status !== 'refunded') {
        purchase.status = 'refunded';
        purchase.refunded_at = new Date();
        await manager.getRepository(ResourcePurchase).save(purchase);
      }
    });
  }
}
