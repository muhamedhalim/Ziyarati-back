import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RefundRecoveryService } from './refund-recovery.service';
import { Refund } from '../../entities/Payments/Refund';
import { REFUND_STATUS } from './payments.constants';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  createMockQueryBuilder,
  createMockConfigService,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

/** FND-026 / T018 — the reaper's own re-clamp, defense-in-depth alongside RefundService's. */
describe('RefundRecoveryService.reapStalePending — completion re-clamp', () => {
  let service: RefundRecoveryService;
  let refunds: MockRepository;
  let paymentsRepo: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let gateways: { resolve: jest.Mock };
  let transactions: { record: jest.Mock };
  let adjustments: { recordClawbackIfSettled: jest.Mock };
  let emitter: { emit: jest.Mock };
  /** `succeededCents` the completion phase reads via raw SQL `m.query(...)`. */
  let succeededCentsRow: Array<{ sum: string }>;

  const pendingRefund = (overrides: Record<string, unknown> = {}) => ({
    id: 'rf-1',
    amount: 60,
    status: REFUND_STATUS.PENDING,
    created_at: new Date(Date.now() - 20 * 60_000), // older than the 10-min default stale threshold
    payment: {
      id: 'pay-1',
      amount: 100,
      gateway_payment_id: null, // internal refund — no gateway branch (the only path with no built-in clamp)
      settlement_status: 'UNSETTLED',
    },
    ...overrides,
  });

  beforeEach(async () => {
    refunds = createMockRepository();
    paymentsRepo = createMockRepository();
    manager = createMockEntityManager();
    manager.getRepository = jest.fn((entity: unknown) =>
      entity === Refund ? refunds : paymentsRepo,
    );
    manager.createQueryBuilder = jest.fn(() => createMockQueryBuilder());
    succeededCentsRow = [{ sum: '0.00' }];
    manager.query = jest.fn().mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('SUM(amount)')) return succeededCentsRow;
      if (typeof sql === 'string' && sql.includes('"tenantId"')) return [{ t: 't1' }];
      return [];
    });
    dataSource = createMockDataSource(manager);

    gateways = { resolve: jest.fn() };
    transactions = { record: jest.fn().mockResolvedValue(undefined) };
    adjustments = { recordClawbackIfSettled: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RefundRecoveryService,
        { provide: getRepositoryToken(Refund), useValue: refunds },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentGatewayFactory, useValue: gateways },
        { provide: TransactionService, useValue: transactions },
        { provide: SettlementAdjustmentService, useValue: adjustments },
        { provide: ConfigService, useValue: createMockConfigService() },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = moduleRef.get(RefundRecoveryService);
  });

  afterEach(() => jest.clearAllMocks());

  it('finalizes an internal (no-gateway) refund SUCCEEDED when it fits the payment amount', async () => {
    const refund = pendingRefund();
    refunds.find.mockResolvedValueOnce([refund]);
    paymentsRepo.findOne.mockResolvedValueOnce({ id: 'pay-1', amount: 100, settlement_status: 'UNSETTLED' });
    refunds.findOneBy.mockResolvedValueOnce({ ...refund, status: REFUND_STATUS.PENDING });
    succeededCentsRow = [{ sum: '0.00' }];

    const summary = await service.reapStalePending();

    expect(summary.succeeded).toBe(1);
    expect(refunds.save).toHaveBeenCalledWith(expect.objectContaining({ status: REFUND_STATUS.SUCCEEDED }));
  });

  // Phase 1.6 (plan §14) — RefundRecordedEvent, emitted post-commit only.
  describe('RefundRecordedEvent (Phase 1.6 — plan §14)', () => {
    it('emits when the reaper finalizes a refund SUCCEEDED, with the cumulative total in MINOR units', async () => {
      // succeededCentsRow is a fixed (non-queued) mock — the SAME value backs
      // both the pre-finalize re-clamp check and the post-finalize cumulative
      // read, so it must stay low enough to pass the re-clamp
      // (succeededCents + thisCents(60) <= payment amount(100)).
      const refund = pendingRefund();
      refunds.find.mockResolvedValueOnce([refund]);
      paymentsRepo.findOne.mockResolvedValueOnce({ id: 'pay-1', amount: 100, settlement_status: 'UNSETTLED' });
      refunds.findOneBy.mockResolvedValueOnce({ ...refund, status: REFUND_STATUS.PENDING });
      succeededCentsRow = [{ sum: '0.00' }];

      const summary = await service.reapStalePending();

      expect(summary.succeeded).toBe(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        'refund.recorded',
        expect.objectContaining({
          tenantId: 't1',
          paymentId: 'pay-1',
          refundId: 'rf-1',
          refundedCumulativeMinor: 0,
          paymentTotalMinor: 10000,
        }),
      );
    });

    it('does NOT emit when the refund cannot be finalized yet (still PENDING)', async () => {
      const refund = pendingRefund({
        payment: { id: 'pay-1', amount: 100, gateway_payment_id: 'gw-1', settlement_status: 'UNSETTLED' },
      });
      refunds.find.mockResolvedValueOnce([refund]);
      gateways.resolve.mockReturnValueOnce({
        verifyPayment: jest.fn().mockResolvedValue({ refundedMinorUnits: null, refundExplicitlyFailed: false }),
      });

      const summary = await service.reapStalePending();

      expect(summary.stillPending).toBe(1);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does NOT emit when the reaper finalizes a refund FAILED', async () => {
      const refund = pendingRefund({ amount: 60 });
      refunds.find.mockResolvedValueOnce([refund]);
      paymentsRepo.findOne.mockResolvedValueOnce({ id: 'pay-1', amount: 100, settlement_status: 'UNSETTLED' });
      refunds.findOneBy.mockResolvedValueOnce({ ...refund, status: REFUND_STATUS.PENDING });
      succeededCentsRow = [{ sum: '60.00' }]; // already 60 succeeded elsewhere — this 60 would exceed 100

      await service.reapStalePending();

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  it('re-clamps: refuses to finalize an internal refund past the payment amount even with succeed=true', async () => {
    // Another refund already succeeded for 60 on this 100 payment; this
    // stale-PENDING row is also for 60 — finalizing it would total 120 > 100.
    const refund = pendingRefund({ amount: 60 });
    refunds.find.mockResolvedValueOnce([refund]);
    paymentsRepo.findOne.mockResolvedValueOnce({ id: 'pay-1', amount: 100, settlement_status: 'UNSETTLED' });
    refunds.findOneBy.mockResolvedValueOnce({ ...refund, status: REFUND_STATUS.PENDING });
    succeededCentsRow = [{ sum: '60.00' }];

    const summary = await service.reapStalePending();

    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    expect(refunds.save).toHaveBeenCalledWith(expect.objectContaining({ status: REFUND_STATUS.FAILED }));
  });

  it('the gateway-headroom branch stays clamped to the payment amount (unchanged behavior)', async () => {
    const refund = pendingRefund({
      amount: 60,
      payment: { id: 'pay-1', amount: 100, gateway_payment_id: 'gw-1', settlement_status: 'UNSETTLED' },
    });
    refunds.find.mockResolvedValueOnce([refund]);
    gateways.resolve.mockReturnValueOnce({
      verifyPayment: jest.fn().mockResolvedValue({ refundedMinorUnits: 6000, refundExplicitlyFailed: false }),
    });
    paymentsRepo.findOne.mockResolvedValueOnce({
      id: 'pay-1',
      amount: 100,
      gateway_payment_id: 'gw-1',
      settlement_status: 'UNSETTLED',
    });
    refunds.findOneBy.mockResolvedValueOnce({ ...refund, status: REFUND_STATUS.PENDING });
    succeededCentsRow = [{ sum: '0.00' }];

    const summary = await service.reapStalePending();

    expect(summary.succeeded).toBe(1); // 60 headroom covers this 60 row — untouched by the new guard
  });

  // REL-005 — same guarantee as RefundService.create, for a refund the reaper finalizes.
  describe('REL-005 — durable refund_recorded row', () => {
    const outboxRows = () =>
      (manager.createQueryBuilder as jest.Mock).mock.results
        .map((r) => r.value as ReturnType<typeof createMockQueryBuilder>)
        .flatMap((qb) => qb.values.mock.calls.map(([row]) => row))
        .filter((row) => row?.job_name === 'payments.outcome');

    it('writes a refund_recorded row when the reaper finalizes a refund SUCCEEDED', async () => {
      const refund = pendingRefund();
      refunds.find.mockResolvedValueOnce([refund]);
      paymentsRepo.findOne.mockResolvedValueOnce({ id: 'pay-1', amount: 100, settlement_status: 'UNSETTLED' });
      refunds.findOneBy.mockResolvedValueOnce({ ...refund, status: REFUND_STATUS.PENDING });
      succeededCentsRow = [{ sum: '0.00' }];

      await service.reapStalePending();

      expect(outboxRows()).toEqual([
        expect.objectContaining({
          dedupe_key: 'payment-outcome-refund-rf-1',
          payload: {
            tenantId: 't1',
            paymentId: 'pay-1',
            outcome: 'refund_recorded',
            refundId: 'rf-1',
          },
        }),
      ]);
    });

    it('writes NO row when the refund cannot be finalized yet, or is finalized FAILED', async () => {
      const refund = pendingRefund({ amount: 60 });
      refunds.find.mockResolvedValueOnce([refund]);
      paymentsRepo.findOne.mockResolvedValueOnce({ id: 'pay-1', amount: 100, settlement_status: 'UNSETTLED' });
      refunds.findOneBy.mockResolvedValueOnce({ ...refund, status: REFUND_STATUS.PENDING });
      succeededCentsRow = [{ sum: '60.00' }]; // this 60 would exceed the 100 payment

      await service.reapStalePending();

      expect(outboxRows()).toEqual([]);
    });
  });
});
