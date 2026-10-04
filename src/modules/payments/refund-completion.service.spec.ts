import { RefundCompletionService } from './refund-completion.service';
import { PaymentStatus, SettlementStatus } from '../../entities/enums';
import {
  createMockEntityManager,
  createMockQueryBuilder,
  createMockRepository,
  MockEntityManager,
  MockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { Refund } from '../../entities/Payments/Refund';
import { Payment } from '../../entities/Payments/Payment';

const TENANT = 't1';

describe('RefundCompletionService.complete', () => {
  let service: RefundCompletionService;
  let m: MockEntityManager;
  let refundRepo: MockRepository;
  let paymentRepo: MockRepository;
  let transactions: { record: jest.Mock };
  let adjustments: { recordClawbackIfSettled: jest.Mock };
  let emitter: { emit: jest.Mock };
  let builders: MockQueryBuilder[];
  /** `{sum}` rows getRawOne() answers, one per query builder, last value sticks. */
  let sums: string[];

  const payment = (over: Record<string, unknown> = {}): any => ({
    id: 'pay-1',
    amount: 100,
    currency: 'SAR',
    status: PaymentStatus.PAID,
    settlement_mode: 'INTERNAL',
    settlement_status: SettlementStatus.UNSETTLED,
    ...over,
  });
  const refund = (over: Record<string, unknown> = {}): any => ({
    id: 'rf-1',
    amount: 60,
    status: 'PENDING',
    ...over,
  });
  const outbox = () =>
    builders
      .flatMap((qb) => qb.values.mock.calls.map(([row]) => row))
      .filter((row) => row?.job_name === 'payments.outcome');

  beforeEach(() => {
    refundRepo = createMockRepository();
    paymentRepo = createMockRepository();
    refundRepo.save.mockImplementation(async (r: any) => r);
    paymentRepo.save.mockImplementation(async (p: any) => p);
    m = createMockEntityManager(
      new Map<unknown, MockRepository>([
        [Refund, refundRepo],
        [Payment, paymentRepo],
      ]),
    );
    builders = [];
    sums = ['0.00'];
    m.createQueryBuilder = jest.fn(() => {
      const qb = createMockQueryBuilder();
      const next = sums.length > 1 ? sums.shift()! : sums[0];
      qb.getRawOne = jest.fn().mockResolvedValue({ sum: next });
      builders.push(qb);
      return qb;
    });
    transactions = { record: jest.fn().mockResolvedValue(undefined) };
    adjustments = {
      recordClawbackIfSettled: jest.fn().mockResolvedValue(undefined),
    };
    emitter = { emit: jest.fn() };
    service = new RefundCompletionService(
      transactions as any,
      adjustments as any,
      emitter as any,
    );
  });

  describe('succeeded', () => {
    it('books the refund, stamps the gateway id, writes the ledger row and advances the payment (partial)', async () => {
      // re-clamp read = 0 succeeded so far, cumulative read after = 60
      sums = ['0.00', '60.00'];
      const p = payment();
      const r = refund();

      const out = await service.complete(m as any, {
        tenantId: TENANT,
        payment: p,
        refund: r,
        outcome: 'succeeded',
        gatewayRefundId: 're_1',
        gatewayTransactionId: 'chg_1',
        raw: { id: 're_1' },
      });

      expect(out.status).toBe('SUCCEEDED');
      expect(r).toMatchObject({
        status: 'SUCCEEDED',
        gateway_refund_id: 're_1',
      });
      expect(transactions.record).toHaveBeenCalledWith(
        TENANT,
        'pay-1',
        expect.objectContaining({
          type: 'refund',
          amount: 60,
          status: 'succeeded',
          gatewayTransactionId: 'chg_1',
          raw: { id: 're_1' },
        }),
        m,
      );
      expect(p).toMatchObject({
        status: PaymentStatus.PARTIALLY_REFUNDED,
        refunded_amount: 60,
        refund_status: 'PARTIAL',
      });
      expect(p.refunded_at).toBeInstanceOf(Date);
      expect(out.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(out.recordedEvent).toMatchObject({
        refundId: 'rf-1',
        refundedCumulativeMinor: 6000,
        paymentTotalMinor: 10000,
      });
    });

    it('a refund that completes the payment makes it REFUNDED / FULL', async () => {
      sums = ['0.00', '100.00'];
      const p = payment();
      await service.complete(m as any, {
        tenantId: TENANT,
        payment: p,
        refund: refund({ amount: 100 }),
        outcome: 'succeeded',
      });
      expect(p).toMatchObject({
        status: PaymentStatus.REFUNDED,
        refund_status: 'FULL',
        refunded_amount: 100,
      });
    });

    it('queues BOTH durable consequences in the same transaction: entitlement reversal AND the booking payment-status', async () => {
      sums = ['0.00', '60.00'];
      await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment(),
        refund: refund(),
        outcome: 'succeeded',
      });
      expect(outbox()).toEqual([
        expect.objectContaining({
          dedupe_key: 'payment-outcome-refund-rf-1',
          payload: {
            tenantId: TENANT,
            paymentId: 'pay-1',
            outcome: 'refund_recorded',
            refundId: 'rf-1',
          },
        }),
        expect.objectContaining({
          dedupe_key: 'payment-outcome-refunded-pay-1-6000',
          payload: {
            tenantId: TENANT,
            paymentId: 'pay-1',
            outcome: 'refunded',
          },
        }),
      ]);
    });

    it('re-clamps: a gateway success is refused (FAILED) when the true total would pass the payment amount', async () => {
      sums = ['60.00']; // 60 already succeeded; this 60 would make 120 > 100
      const p = payment();
      const r = refund();

      const out = await service.complete(m as any, {
        tenantId: TENANT,
        payment: p,
        refund: r,
        outcome: 'succeeded',
      });

      expect(out.status).toBe('FAILED');
      expect(out.failureReason).toMatch(
        /exceed the remaining refundable balance/,
      );
      expect(r.status).toBe('FAILED');
      expect(p.status).toBe(PaymentStatus.PAID);
      expect(outbox()).toEqual([]);
      expect(out.recordedEvent).toBeUndefined();
    });

    it('does not re-clamp away a refund that exactly fills the payment', async () => {
      sums = ['40.00', '100.00'];
      const out = await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment(),
        refund: refund({ amount: 60 }),
        outcome: 'succeeded',
      });
      expect(out.status).toBe('SUCCEEDED');
    });
  });

  describe('failed', () => {
    it('marks the refund FAILED, records the ledger row, and leaves the payment and the outbox alone', async () => {
      const p = payment();
      const r = refund();

      const out = await service.complete(m as any, {
        tenantId: TENANT,
        payment: p,
        refund: r,
        outcome: 'failed',
        failureReason: 'Refund was rejected by the payment gateway',
        gatewayTransactionId: 'chg_1',
      });

      expect(out).toMatchObject({
        status: 'FAILED',
        paymentStatus: PaymentStatus.PAID,
        failureReason: 'Refund was rejected by the payment gateway',
      });
      expect(r.status).toBe('FAILED');
      expect(transactions.record).toHaveBeenCalledWith(
        TENANT,
        'pay-1',
        expect.objectContaining({ type: 'refund', status: 'failed' }),
        m,
      );
      expect(paymentRepo.save).not.toHaveBeenCalled();
      expect(outbox()).toEqual([]);
      expect(adjustments.recordClawbackIfSettled).not.toHaveBeenCalled();
    });

    it('keeps an already-known gateway id and does not overwrite it', async () => {
      const r = refund({ gateway_refund_id: 're_keep' });
      await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment(),
        refund: r,
        outcome: 'failed',
        gatewayRefundId: 're_other',
      });
      expect(r.gateway_refund_id).toBe('re_keep');
    });
  });

  describe('the internal clawback is only for money ZiyaraTech itself holds', () => {
    it.each([
      ['INTERNAL', true],
      ['PROVIDER', false], // Tap debits the clinic wallet directly
      ['NONE', false],
    ])('settlement_mode %s → clawback called: %s', async (mode, called) => {
      sums = ['0.00', '60.00'];
      await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment({
          settlement_mode: mode,
          settlement_status: SettlementStatus.SETTLED,
        }),
        refund: refund(),
        outcome: 'succeeded',
      });
      expect(adjustments.recordClawbackIfSettled.mock.calls.length).toBe(
        called ? 1 : 0,
      );
    });
  });

  describe('announce (the webhook path only)', () => {
    it('builds payment.refunded with isPartial for a partial refund', async () => {
      sums = ['0.00', '60.00'];
      const out = await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment(),
        refund: refund(),
        outcome: 'succeeded',
        announce: { customerId: 'c1', appointmentId: 'a1' },
      });
      expect(out.refundedEvent).toMatchObject({
        paymentId: 'pay-1',
        customerId: 'c1',
        appointmentId: 'a1',
        isPartial: true,
        amount: 100,
        currency: 'SAR',
      });
    });

    it('is not built without the flag, nor for a failed refund', async () => {
      sums = ['0.00', '60.00'];
      const a = await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment(),
        refund: refund(),
        outcome: 'succeeded',
      });
      expect(a.refundedEvent).toBeUndefined();

      const b = await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment(),
        refund: refund({ id: 'rf-2' }),
        outcome: 'failed',
        announce: { customerId: 'c1' },
      });
      expect(b.refundedEvent).toBeUndefined();
    });
  });

  describe('emitAfterCommit', () => {
    it('emits the in-process events of a committed completion', async () => {
      sums = ['0.00', '100.00'];
      const out = await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment(),
        refund: refund({ amount: 100 }),
        outcome: 'succeeded',
        announce: { customerId: 'c1' },
      });
      service.emitAfterCommit(out);
      expect(emitter.emit).toHaveBeenCalledWith(
        'refund.recorded',
        expect.objectContaining({ refundId: 'rf-1' }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'payment.refunded',
        expect.objectContaining({ paymentId: 'pay-1', isPartial: false }),
      );
    });

    it('emits nothing for no completion or a failed one', async () => {
      service.emitAfterCommit(undefined);
      const out = await service.complete(m as any, {
        tenantId: TENANT,
        payment: payment(),
        refund: refund(),
        outcome: 'failed',
      });
      service.emitAfterCommit(out);
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
