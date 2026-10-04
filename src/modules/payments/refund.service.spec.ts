import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RefundService, refundOutcomeOf } from './refund.service';
import { RefundCompletionService } from './refund-completion.service';
import { Payment } from '../../entities/Payments/Payment';
import { Refund } from '../../entities/Payments/Refund';
import { PaymentStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  createMockQueryBuilder,
  MockRepository,
  MockDataSource,
  MockEntityManager,
  MockQueryBuilder,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

/**
 * Unit-level companion to `test/refund-concurrency.e2e-spec.ts` (the real-PG
 * proof for FND-026; VR-001 — mocks are never evidence for the concurrency
 * property itself). These tests pin the ADMISSION ARITHMETIC and the
 * completion-phase re-clamp in isolation, fast and deterministic.
 */
describe('RefundService.create — FND-026 admission and re-clamp', () => {
  let service: RefundService;
  let refunds: MockRepository;
  let payments: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let gateway: { name: string; refundPayment: jest.Mock };
  let transactions: { record: jest.Mock };
  let adjustments: { recordClawbackIfSettled: jest.Mock };
  let emitter: { emit: jest.Mock };
  /** Every createQueryBuilder() call, in invocation order, for inspecting `andWhere`/`getRawOne`. */
  let queryBuilders: MockQueryBuilder[];
  /** Queue of `{sum}` rows `getRawOne()` resolves to, consumed one per createQueryBuilder() call. */
  let sumQueue: string[];

  const paidPayment = (overrides: Record<string, unknown> = {}) => ({
    id: 'pay-1',
    amount: 100,
    currency: 'SAR',
    status: PaymentStatus.PAID,
    gateway_payment_id: 'gw-pay-1',
    gateway: 'noop',
    ...overrides,
  });

  beforeEach(async () => {
    refunds = createMockRepository();
    (refunds as unknown as { findOneByOrFail: jest.Mock }).findOneByOrFail = jest.fn();
    payments = createMockRepository();

    const repoMap = new Map<unknown, MockRepository>([
      [Payment, payments],
      [Refund, refunds],
    ]);
    manager = createMockEntityManager(repoMap);

    queryBuilders = [];
    sumQueue = ['0.00']; // default: nothing admitted/succeeded yet, unless a test overrides it
    manager.createQueryBuilder = jest.fn(() => {
      const qb = createMockQueryBuilder();
      const nextSum = sumQueue.length > 1 ? sumQueue.shift()! : sumQueue[0];
      qb.getRawOne = jest.fn().mockResolvedValue({ sum: nextSum });
      queryBuilders.push(qb);
      return qb;
    });

    dataSource = createMockDataSource(manager);

    gateway = {
      name: 'noop',
      refundPayment: jest.fn().mockResolvedValue({ success: true, gatewayRefundId: 'gw-rf-1', raw: {} }),
    };
    transactions = { record: jest.fn().mockResolvedValue(undefined) };
    adjustments = { recordClawbackIfSettled: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RefundService,
        RefundCompletionService,
        { provide: getRepositoryToken(Refund), useValue: refunds },
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentGatewayFactory, useValue: { resolve: jest.fn().mockReturnValue(gateway) } },
        { provide: TransactionService, useValue: transactions },
        { provide: SettlementAdjustmentService, useValue: adjustments },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = moduleRef.get(RefundService);
  });

  afterEach(() => jest.clearAllMocks());

  it('admits a legitimate refund within the remaining balance', async () => {
    payments.findOne.mockResolvedValue(paidPayment());
    refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
    refunds.save.mockImplementation(async (r: any) => r);
    (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
    sumQueue = ['0.00']; // no prior PENDING/SUCCEEDED anywhere in this payment's history

    const result = await service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any);

    expect(result.status).toBe('SUCCEEDED');
    expect(gateway.refundPayment).toHaveBeenCalled();
  });

  // Phase 1.6 (plan §14) — RefundRecordedEvent, emitted post-commit only.
  describe('RefundRecordedEvent (Phase 1.6 — plan §14)', () => {
    it('emits AFTER the transaction commits, with the cumulative SUCCEEDED total and payment total in MINOR units', async () => {
      payments.findOne.mockResolvedValue(paidPayment());
      refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
      refunds.save.mockImplementation(async (r: any) => r);
      (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
      // admission=0, completion re-clamp=0, final cumulative-succeeded=60.
      sumQueue = ['0.00', '0.00', '60.00'];

      await service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any);

      expect(emitter.emit).toHaveBeenCalledWith(
        'refund.recorded',
        expect.objectContaining({
          tenantId: TENANT,
          paymentId: 'pay-1',
          refundId: 'rf-1',
          refundedCumulativeMinor: 6000,
          paymentTotalMinor: 10000,
        }),
      );
    });

    it('does NOT emit when the refund is declined by the gateway (create() rejects, nothing committed)', async () => {
      payments.findOne.mockResolvedValue(paidPayment());
      refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
      refunds.save.mockImplementation(async (r: any) => r);
      (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
      sumQueue = ['0.00'];
      gateway.refundPayment.mockResolvedValueOnce({ success: false, failureReason: 'declined', raw: {} });

      await expect(
        service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does NOT re-emit on an idempotency-key replay (the event already fired on the original create)', async () => {
      const existing = { id: 'rf-1', status: 'SUCCEEDED' };
      refunds.findOne.mockResolvedValueOnce(existing);

      const result = await service.create(TENANT, { paymentId: 'pay-1', amount: 60, idempotencyKey: 'k1' } as any);

      expect(result).toBe(existing);
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  it('REJECTS a refund that would push admitted total past the payment amount (a PENDING refund already reserved the rest)', async () => {
    payments.findOne.mockResolvedValue(paidPayment());
    // The admission query — the FIRST createQueryBuilder() call, inside persistIntent — now
    // returns 60 already admitted (a concurrent PENDING refund the widened sum must see).
    sumQueue = ['60.00'];

    await expect(
      service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

    // Rejected during Phase 1 (persistIntent) — the gateway must never be reached.
    expect(gateway.refundPayment).not.toHaveBeenCalled();
  });

  it('the admission query counts PENDING and SUCCEEDED (not SUCCEEDED alone)', async () => {
    payments.findOne.mockResolvedValue(paidPayment());
    refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
    refunds.save.mockImplementation(async (r: any) => r);
    (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
    sumQueue = ['0.00'];

    await service.create(TENANT, { paymentId: 'pay-1', amount: 10 } as any);

    const admissionQb = queryBuilders[0];
    const statusFilterCall = admissionQb.andWhere.mock.calls.find(([, params]: [string, any]) =>
      Array.isArray(params?.statuses),
    );
    expect(statusFilterCall).toBeDefined();
    expect(statusFilterCall![1].statuses).toEqual(expect.arrayContaining(['PENDING', 'SUCCEEDED']));
    expect(statusFilterCall![1].statuses).not.toContain('FAILED');
  });

  it('FAILED refunds are still excluded from admission (capacity releases on failure)', async () => {
    payments.findOne.mockResolvedValue(paidPayment());
    refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
    refunds.save.mockImplementation(async (r: any) => r);
    (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
    // A prior refund attempt FAILED — the admission sum must read as if it never happened.
    sumQueue = ['0.00'];

    const result = await service.create(TENANT, { paymentId: 'pay-1', amount: 100 } as any);
    expect(result.status).toBe('SUCCEEDED'); // full 100 admitted — nothing held back for the FAILED one
  });

  it('re-clamps at completion: a gateway "ok" is refused, not trusted, once the true total would exceed the payment amount', async () => {
    payments.findOne.mockResolvedValue(paidPayment());
    refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
    refunds.save.mockImplementation(async (r: any) => r);
    (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
    // 1st call = Phase-1 admission (0 admitted yet → this 60 is let through).
    // 2nd call = Phase-3 completion re-clamp — by now another refund has ALREADY
    // succeeded for 60, so admitting this one too would total 120 > 100.
    sumQueue = ['0.00', '60.00'];

    // Refused at completion (same UNPROCESSABLE_ENTITY contract as a genuine
    // gateway decline — refund.service.ts:157), despite the gateway itself
    // reporting success; the underlying row is persisted as FAILED.
    await expect(
      service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

    expect(gateway.refundPayment).toHaveBeenCalled(); // Phase 1 admitted it; the gateway WAS called
    expect(refunds.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
  });

  it('does not re-clamp away a legitimate completion (succeeded sum still fits)', async () => {
    payments.findOne.mockResolvedValue(paidPayment());
    refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
    refunds.save.mockImplementation(async (r: any) => r);
    (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
    sumQueue = ['0.00', '0.00', '60.00']; // admission, re-clamp (0 succeeded so far), ledger (after save)

    const result = await service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any);
    expect(result.status).toBe('SUCCEEDED');
  });

  it('the pessimistic_write lock is still taken on both the admission and completion phases', async () => {
    payments.findOne.mockResolvedValue(paidPayment());
    refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
    refunds.save.mockImplementation(async (r: any) => r);
    (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
    sumQueue = ['0.00'];

    await service.create(TENANT, { paymentId: 'pay-1', amount: 10 } as any);

    const lockedCalls = payments.findOne.mock.calls.filter(
      ([opts]: [any]) => opts?.lock?.mode === 'pessimistic_write',
    );
    expect(lockedCalls.length).toBe(2); // persistIntent + the completion phase
  });

  // REL-005 — the entitlement reversal rides in the SAME transaction as the
  // refund, so a crash after the commit cannot leave a refunded add-on granted.
  describe('REL-005 — durable refund_recorded row', () => {
    const outboxRows = () =>
      queryBuilders
        .flatMap((qb) => qb.values.mock.calls.map(([row]) => row))
        .filter((row) => row?.job_name === 'payments.outcome');

    it('a SUCCEEDED refund writes a refund_recorded row keyed by the refund id, via the transaction manager', async () => {
      payments.findOne.mockResolvedValue(paidPayment());
      refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
      refunds.save.mockImplementation(async (r: any) => r);
      (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
      sumQueue = ['0.00', '0.00', '60.00'];

      await service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any);

      expect(outboxRows()).toEqual([
        expect.objectContaining({
          queue: 'payments',
          job_name: 'payments.outcome',
          dedupe_key: 'payment-outcome-refund-rf-1',
          payload: {
            tenantId: TENANT,
            paymentId: 'pay-1',
            outcome: 'refund_recorded',
            refundId: 'rf-1',
          },
        }),
        // …and the booking is told its payment was refunded (staff refunds never did).
        expect.objectContaining({
          dedupe_key: 'payment-outcome-refunded-pay-1-6000',
          payload: {
            tenantId: TENANT,
            paymentId: 'pay-1',
            outcome: 'refunded',
          },
        }),
      ]);
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('writes NO row when the gateway declines the refund', async () => {
      payments.findOne.mockResolvedValue(paidPayment());
      refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
      refunds.save.mockImplementation(async (r: any) => r);
      (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
      sumQueue = ['0.00'];
      gateway.refundPayment.mockResolvedValueOnce({ success: false, failureReason: 'declined', raw: {} });

      await expect(
        service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any),
      ).rejects.toBeDefined();

      expect(outboxRows()).toEqual([]);
    });

    it('writes NO row on an idempotency-key replay', async () => {
      refunds.findOne.mockResolvedValueOnce({ id: 'rf-1', status: 'SUCCEEDED' });
      await service.create(TENANT, { paymentId: 'pay-1', amount: 60, idempotencyKey: 'k1' } as any);
      expect(outboxRows()).toEqual([]);
    });
  });

  // ── Tap-era behaviour: asynchronous refunds, persisted failure, idempotent replay ──
  describe('asynchronous and failed gateway outcomes', () => {
    const arrange = (sums: string[] = ['0.00']) => {
      payments.findOne.mockResolvedValue(paidPayment());
      refunds.create.mockImplementation((data: any) => ({ id: 'rf-1', ...data }));
      refunds.save.mockImplementation(async (r: any) => r);
      (refunds as any).findOneByOrFail.mockResolvedValue({ id: 'rf-1', amount: 60, status: 'PENDING' });
      sumQueue = sums;
    };
    const outboxRows = () =>
      queryBuilders
        .flatMap((qb) => qb.values.mock.calls.map(([row]) => row))
        .filter((row) => row?.job_name === 'payments.outcome');

    it('a PENDING gateway answer keeps the refund PENDING, stores the gateway id, and moves nothing else', async () => {
      arrange();
      gateway.refundPayment.mockResolvedValueOnce({
        success: false,
        status: 'pending',
        gatewayRefundId: 're_tap_1',
        failureReason: 'Refund is pending at the payment gateway',
        raw: { id: 're_tap_1' },
      });

      const result = await service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any);

      expect(result.status).toBe('PENDING');
      // the provider's refund id is what the webhook and the reaper find it by
      expect(refunds.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'PENDING', gateway_refund_id: 're_tap_1' }),
      );
      // the payment is untouched: no status change, no aggregates, no durable outcomes, no events
      expect(payments.save).not.toHaveBeenCalled();
      expect(outboxRows()).toEqual([]);
      expect(emitter.emit).not.toHaveBeenCalled();
      // …and the ledger says what the gateway said
      expect(transactions.record).toHaveBeenCalledWith(
        TENANT,
        'pay-1',
        expect.objectContaining({ type: 'refund', status: 'pending' }),
        manager,
      );
    });

    it('an UNKNOWN answer (outage / timeout) is never a failure: the refund stays PENDING', async () => {
      arrange();
      gateway.refundPayment.mockResolvedValueOnce({
        success: false,
        status: 'unknown',
        failureReason: 'Payment gateway is temporarily unavailable',
      });

      const result = await service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any);

      expect(result.status).toBe('PENDING');
      expect(refunds.save).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
      expect(outboxRows()).toEqual([]);
    });

    it('a DECLINE is COMMITTED as FAILED before the error is raised (it used to roll back and stay PENDING)', async () => {
      arrange();
      gateway.refundPayment.mockResolvedValueOnce({
        success: false,
        status: 'failed',
        failureReason: 'Refund was rejected by the payment gateway',
        failureCode: '1161',
      });
      const order: string[] = [];
      refunds.save.mockImplementation(async (r: any) => {
        if (r.status === 'FAILED') order.push('saved-failed');
        return r;
      });
      const realTransaction = dataSource.transaction.getMockImplementation()!;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        const out = await realTransaction(cb);
        order.push('committed');
        return out;
      });

      await expect(
        service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

      // FAILED was written inside the Phase-3 transaction, and that transaction
      // committed — the refusal came after, so nothing was rolled back.
      expect(order.indexOf('saved-failed')).toBeGreaterThan(-1);
      expect(order.lastIndexOf('committed')).toBeGreaterThan(order.indexOf('saved-failed'));
      expect(transactions.record).toHaveBeenCalledWith(
        TENANT,
        'pay-1',
        expect.objectContaining({ type: 'refund', status: 'failed' }),
        manager,
      );
      expect(payments.save).not.toHaveBeenCalled(); // the payment is untouched by a failed refund
    });

    it('does not apply twice when a webhook already finished the refund while the gateway call was in flight', async () => {
      arrange();
      (refunds as any).findOneByOrFail.mockResolvedValue({
        id: 'rf-1',
        amount: 60,
        status: 'SUCCEEDED',
        gateway_refund_id: 're_tap_1',
      });

      const result = await service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any);

      expect(result.status).toBe('SUCCEEDED');
      expect(refunds.save).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCEEDED' }));
      expect(outboxRows()).toEqual([]);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a provider that predates status (legacy Moyasar: only success) still maps true to succeeded, false to failed', () => {
      expect(refundOutcomeOf({ success: true })).toBe('succeeded');
      expect(refundOutcomeOf({ success: false })).toBe('failed');
      expect(refundOutcomeOf({ success: false, status: 'pending' })).toBe('pending');
      expect(refundOutcomeOf({ success: true, status: 'succeeded' })).toBe('succeeded');
    });

    it('passes the refund id to the gateway (the per-refund idempotency key)', async () => {
      arrange();
      await service.create(TENANT, { paymentId: 'pay-1', amount: 60 } as any);
      expect(gateway.refundPayment).toHaveBeenCalledWith(
        expect.objectContaining({ refundId: 'rf-1', paymentId: 'pay-1' }),
      );
    });
  });
});
