import { ResourceEntitlementListener } from './resource-entitlement.listener';
import { PaymentSucceededEvent, PaymentFailedEvent } from '../../events/payment.events';
import { RefundRecordedEvent } from '../../events/refund.events';
import { LEDGER_REASON } from '../subscription-billing/tenant-entitlement-ledger.service';

function capacityPurchase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'purchase-1',
    tenant: { id: 't1' },
    item_key: 'branches',
    kind: 'capacity',
    delta_units: '3',
    total_minor: '15000',
    status: 'payment_processing',
    ...overrides,
  };
}

function creditPurchase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'purchase-2',
    tenant: { id: 't1' },
    item_key: 'ai_tokens',
    kind: 'credit',
    delta_units: '3000',
    total_minor: '10000',
    status: 'completed',
    ...overrides,
  };
}

describe('ResourceEntitlementListener (Phase 2.3, plan §14/§20)', () => {
  let qb: {
    where: jest.Mock;
    setLock: jest.Mock;
    innerJoinAndSelect: jest.Mock;
    getOne: jest.Mock;
  };
  let repo: { createQueryBuilder: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let ledger: { grant: jest.Mock; revoke: jest.Mock; sumRevokedForPurchase: jest.Mock };
  let credits: { credit: jest.Mock; revoke: jest.Mock };
  let listener: ResourceEntitlementListener;

  beforeEach(() => {
    qb = {
      where: jest.fn(),
      setLock: jest.fn(),
      innerJoinAndSelect: jest.fn(),
      getOne: jest.fn(),
    };
    // Chainable, matching TypeORM's SelectQueryBuilder fluent API.
    qb.where.mockReturnValue(qb);
    qb.setLock.mockReturnValue(qb);
    qb.innerJoinAndSelect.mockReturnValue(qb);

    repo = { createQueryBuilder: jest.fn(() => qb), save: jest.fn(async (e: any) => e) };
    dataSource = {
      transaction: jest.fn(async (cb: any) => cb({ getRepository: () => repo })),
    };
    ledger = {
      grant: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
      revoke: jest.fn().mockResolvedValue({ id: 'ledger-2' }),
      sumRevokedForPurchase: jest.fn().mockResolvedValue(0),
    };
    credits = {
      credit: jest.fn().mockResolvedValue({}),
      revoke: jest.fn().mockResolvedValue({ clawedBackUnits: 0, unrecoverableUnits: 0 }),
    };

    listener = new ResourceEntitlementListener(dataSource as never, ledger as never, credits as never);
  });

  it('locks by the raw "paymentId" column, never by joining the nullable payment relation', async () => {
    // Regression guard for the real-Postgres finding: FOR UPDATE cannot be
    // applied across a LEFT JOIN on a nullable relation. Every lookup must
    // filter on the raw FK column via query builder, not `where: { payment: { id } } }`.
    qb.getOne.mockResolvedValueOnce(null);
    await listener.onPaymentSucceeded(new PaymentSucceededEvent('t1', 'pay-1', 100, 'SAR', undefined));
    expect(qb.where).toHaveBeenCalledWith('purchase."paymentId" = :paymentId', { paymentId: 'pay-1' });
    expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
  });

  describe('onPaymentSucceeded', () => {
    const event = new PaymentSucceededEvent('t1', 'pay-1', 100, 'SAR', undefined);

    it('grants ledger capacity and completes the purchase — no credits call for a capacity item', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());

      await listener.onPaymentSucceeded(event);

      expect(ledger.grant).toHaveBeenCalledWith({
        tenantId: 't1',
        metric: 'branches',
        kind: 'capacity',
        amountUnits: 3,
        reason: LEDGER_REASON.PURCHASE,
        sourcePurchaseId: 'purchase-1',
        manager: expect.anything(),
      });
      expect(credits.credit).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', completed_at: expect.any(Date) }),
      );
    });

    it('grants ledger AND credits the balance for a credit item', async () => {
      qb.getOne.mockResolvedValueOnce(creditPurchase({ status: 'payment_processing' }));

      await listener.onPaymentSucceeded(event);

      expect(ledger.grant).toHaveBeenCalledWith(
        expect.objectContaining({ metric: 'ai_tokens', kind: 'credit', amountUnits: 3000 }),
      );
      expect(credits.credit).toHaveBeenCalledWith('t1', 'ai_tokens', 3000, expect.anything());
    });

    it('is a no-op when no resource purchase is linked to the payment', async () => {
      qb.getOne.mockResolvedValueOnce(null);
      await listener.onPaymentSucceeded(event);
      expect(ledger.grant).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('refuses to re-grant a purchase already in a terminal status (G14)', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase({ status: 'completed' }));
      await listener.onPaymentSucceeded(event);
      expect(ledger.grant).not.toHaveBeenCalled();

      qb.getOne.mockResolvedValueOnce(capacityPurchase({ status: 'refunded' }));
      await listener.onPaymentSucceeded(event);
      expect(ledger.grant).not.toHaveBeenCalled();
    });

    it('logs and swallows a failure rather than rethrowing', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());
      ledger.grant.mockRejectedValueOnce(new Error('boom'));
      await expect(listener.onPaymentSucceeded(event)).resolves.toBeUndefined();
    });
  });

  describe('onPaymentFailed', () => {
    const event = new PaymentFailedEvent('t1', 'pay-1', undefined);

    it('transitions payment_processing → payment_failed', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase({ status: 'payment_processing' }));
      await listener.onPaymentFailed(event);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'payment_failed', failed_at: expect.any(Date) }),
      );
    });

    it('leaves a non-processing purchase alone', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase({ status: 'completed' }));
      await listener.onPaymentFailed(event);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('is a no-op when no resource purchase is linked to the payment', async () => {
      qb.getOne.mockResolvedValueOnce(null);
      await listener.onPaymentFailed(event);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('does not join tenant (not needed for this handler)', async () => {
      qb.getOne.mockResolvedValueOnce(null);
      await listener.onPaymentFailed(event);
      expect(qb.innerJoinAndSelect).not.toHaveBeenCalled();
    });
  });

  describe('onRefundRecorded (plan §14 proportional formula)', () => {
    it('fully refunded ⇒ revokes the full delta and marks the purchase refunded', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());
      const event = new RefundRecordedEvent('t1', 'pay-1', 'refund-1', 15000, 15000);

      await listener.onRefundRecorded(event);

      expect(ledger.revoke).toHaveBeenCalledWith({
        tenantId: 't1',
        metric: 'branches',
        kind: 'capacity',
        amountUnits: 3,
        unrecoverableUnits: 0,
        reason: LEDGER_REASON.REFUND,
        sourcePurchaseId: 'purchase-1',
        sourceRefundId: 'refund-1',
        manager: expect.anything(),
      });
      expect(credits.revoke).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'refunded', refunded_at: expect.any(Date) }),
      );
    });

    it('partial refund ⇒ proportional revoke, credits clawback, status NOT flipped to refunded', async () => {
      qb.getOne.mockResolvedValueOnce(creditPurchase());
      credits.revoke.mockResolvedValueOnce({ clawedBackUnits: 1000, unrecoverableUnits: 500 });
      // targetRevoked = floor(3000 * 5000 / 10000) = 1500
      const event = new RefundRecordedEvent('t1', 'pay-1', 'refund-1', 5000, 10000);

      await listener.onRefundRecorded(event);

      expect(credits.revoke).toHaveBeenCalledWith('t1', 'ai_tokens', 1500, expect.anything());
      expect(ledger.revoke).toHaveBeenCalledWith(
        expect.objectContaining({ amountUnits: 1500, unrecoverableUnits: 500 }),
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('redelivered refund event ⇒ no-op once already fully accounted for', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());
      ledger.sumRevokedForPurchase.mockResolvedValueOnce(3); // already revoked the full amount
      const event = new RefundRecordedEvent('t1', 'pay-1', 'refund-1', 15000, 15000);

      await listener.onRefundRecorded(event);

      expect(ledger.revoke).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('a second partial refund only revokes the NEW delta, not the whole target again', async () => {
      qb.getOne.mockResolvedValueOnce(creditPurchase());
      ledger.sumRevokedForPurchase.mockResolvedValueOnce(1500); // first partial already revoked
      credits.revoke.mockResolvedValueOnce({ clawedBackUnits: 900, unrecoverableUnits: 0 });
      // cumulative refunded now 9000/10000 ⇒ targetRevoked = floor(3000*9000/10000)=2700; newRevoke=2700-1500=1200
      const event = new RefundRecordedEvent('t1', 'pay-1', 'refund-2', 9000, 10000);

      await listener.onRefundRecorded(event);

      expect(credits.revoke).toHaveBeenCalledWith('t1', 'ai_tokens', 1200, expect.anything());
      expect(ledger.revoke).toHaveBeenCalledWith(expect.objectContaining({ amountUnits: 1200 }));
    });

    it('is a no-op when no resource purchase is linked to the payment', async () => {
      qb.getOne.mockResolvedValueOnce(null);
      const event = new RefundRecordedEvent('t1', 'pay-1', 'refund-1', 5000, 10000);
      await listener.onRefundRecorded(event);
      expect(ledger.revoke).not.toHaveBeenCalled();
    });

    it('logs and swallows a failure rather than rethrowing', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());
      ledger.revoke.mockRejectedValueOnce(new Error('boom'));
      const event = new RefundRecordedEvent('t1', 'pay-1', 'refund-1', 15000, 15000);
      await expect(listener.onRefundRecorded(event)).resolves.toBeUndefined();
    });
  });

  // REL-005 — the durable `payments.outcome` consumer calls these directly.
  // Same implementation as the event handlers; unlike them they must THROW, so a
  // failed apply is retried instead of lost.
  describe('applyPaid / applyFailed / applyRefund (REL-005 durable consumer)', () => {
    it('applyPaid grants the purchase exactly as the event handler does', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());

      await listener.applyPaid('pay-1');

      expect(qb.where).toHaveBeenCalledWith('purchase."paymentId" = :paymentId', {
        paymentId: 'pay-1',
      });
      expect(ledger.grant).toHaveBeenCalledWith(
        expect.objectContaining({ amountUnits: 3, sourcePurchaseId: 'purchase-1' }),
      );
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('applyPaid is idempotent across every terminal status (G14)', async () => {
      for (const status of ['completed', 'refunded']) {
        qb.getOne.mockResolvedValueOnce(capacityPurchase({ status }));
        await listener.applyPaid('pay-1');
      }
      expect(ledger.grant).not.toHaveBeenCalled();
    });

    it('applyPaid THROWS when the grant fails…', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());
      ledger.grant.mockRejectedValueOnce(new Error('deadlock detected'));
      await expect(listener.applyPaid('pay-1')).rejects.toThrow('deadlock detected');
    });

    it('…while the event handler swallows the SAME failure', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());
      ledger.grant.mockRejectedValueOnce(new Error('deadlock detected'));
      await expect(
        listener.onPaymentSucceeded(
          new PaymentSucceededEvent('t1', 'pay-1', 100, 'SAR', undefined),
        ),
      ).resolves.toBeUndefined();
    });

    it('applyFailed marks only a purchase still awaiting the payment', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase());
      await listener.applyFailed('pay-1');
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'payment_failed' }),
      );

      repo.save.mockClear();
      qb.getOne.mockResolvedValueOnce(capacityPurchase({ status: 'completed' }));
      await listener.applyFailed('pay-1');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('applyFailed THROWS on failure; the event handler swallows it', async () => {
      qb.getOne.mockRejectedValue(new Error('db down'));
      await expect(listener.applyFailed('pay-1')).rejects.toThrow('db down');
      await expect(
        listener.onPaymentFailed(new PaymentFailedEvent('t1', 'pay-1', undefined)),
      ).resolves.toBeUndefined();
    });

    it('applyRefund revokes in proportion to the cumulative total passed in, stamping the triggering refund id', async () => {
      // 3 units for 15000 minor; 5000 refunded = 1/3 ⇒ revoke 1.
      qb.getOne.mockResolvedValueOnce(capacityPurchase({ status: 'completed' }));

      await listener.applyRefund('pay-1', 'refund-1', 5000);

      expect(ledger.revoke).toHaveBeenCalledWith(
        expect.objectContaining({
          amountUnits: 1,
          sourcePurchaseId: 'purchase-1',
          sourceRefundId: 'refund-1',
          reason: LEDGER_REASON.REFUND,
        }),
      );
    });

    it('applyRefund is idempotent: only the delta against what was already revoked is applied', async () => {
      qb.getOne.mockResolvedValueOnce(capacityPurchase({ status: 'completed' }));
      ledger.sumRevokedForPurchase.mockResolvedValueOnce(1);
      await listener.applyRefund('pay-1', 'refund-1', 5000); // target 1, already 1
      expect(ledger.revoke).not.toHaveBeenCalled();
    });

    it('applyRefund THROWS on failure; the event handler swallows it', async () => {
      qb.getOne.mockResolvedValue(capacityPurchase({ status: 'completed' }));
      ledger.revoke.mockRejectedValue(new Error('db down'));
      await expect(listener.applyRefund('pay-1', 'refund-1', 5000)).rejects.toThrow('db down');
      await expect(
        listener.onRefundRecorded(
          new RefundRecordedEvent('t1', 'pay-1', 'refund-1', 5000, 15000),
        ),
      ).resolves.toBeUndefined();
    });
  });
});
