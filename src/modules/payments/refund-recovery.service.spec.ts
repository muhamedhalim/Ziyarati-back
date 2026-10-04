import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RefundRecoveryService } from './refund-recovery.service';
import { RefundCompletionService } from './refund-completion.service';
import { Refund } from '../../entities/Payments/Refund';
import { REFUND_STATUS } from './payments.constants';
import { ReconciliationExceptionService } from './reconciliation/reconciliation-exception.service';
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
  let exceptions: { raiseQuietly: jest.Mock };
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
    succeededCentsRow = [{ sum: '0.00' }];
    manager.createQueryBuilder = jest.fn(() => {
      const qb = createMockQueryBuilder();
      qb.getRawOne = jest.fn(async () => succeededCentsRow[0]);
      return qb;
    });
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
    exceptions = { raiseQuietly: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RefundRecoveryService,
        RefundCompletionService,
        { provide: getRepositoryToken(Refund), useValue: refunds },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentGatewayFactory, useValue: gateways },
        { provide: TransactionService, useValue: transactions },
        { provide: SettlementAdjustmentService, useValue: adjustments },
        { provide: ConfigService, useValue: createMockConfigService() },
        { provide: EventEmitter2, useValue: emitter },
        { provide: ReconciliationExceptionService, useValue: exceptions },
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
        // the booking learns its payment was refunded (the reaper never told it)
        expect.objectContaining({
          payload: { tenantId: 't1', paymentId: 'pay-1', outcome: 'refunded' },
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

  // ── a gateway that can look ONE refund up (Tap) ─────────────────────────────
  describe('provider path (verifyRefund)', () => {
    let provider: { verifyRefund: jest.Mock; refundPayment: jest.Mock };

    const tapRefund = (overrides: Record<string, unknown> = {}) =>
      pendingRefund({
        amount: 60,
        reason: 'requested_by_customer',
        gateway_refund_id: 're_tap_1',
        payment: {
          id: 'pay-1',
          amount: 100,
          currency: 'SAR',
          gateway: 'tap',
          gateway_payment_id: 'chg_1',
          settlement_status: 'UNSETTLED',
          settlement_mode: 'PROVIDER',
        },
        ...overrides,
      });

    const arrange = (refund: any, verdict?: Record<string, unknown>) => {
      provider = {
        verifyRefund: jest.fn().mockResolvedValue({
          success: verdict?.status === 'succeeded',
          gatewayRefundId: 're_tap_1',
          gatewayPaymentId: 'chg_1',
          amountMinorUnits: 6000,
          currency: 'SAR',
          raw: { id: 're_tap_1' },
          ...verdict,
        }),
        refundPayment: jest.fn(),
      };
      gateways.resolve.mockReturnValue(provider);
      refunds.find.mockResolvedValueOnce([refund]);
      paymentsRepo.findOne.mockResolvedValueOnce({ ...refund.payment });
      refunds.findOneBy.mockResolvedValueOnce({ ...refund, status: REFUND_STATUS.PENDING });
    };

    it('books a refund the gateway reports REFUNDED as SUCCEEDED, with the gateway refund id', async () => {
      const refund = tapRefund();
      arrange(refund, { status: 'succeeded' });

      const summary = await service.reapStalePending();

      expect(provider.verifyRefund).toHaveBeenCalledWith('re_tap_1');
      expect(summary.succeeded).toBe(1);
      expect(refunds.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: REFUND_STATUS.SUCCEEDED, gateway_refund_id: 're_tap_1' }),
      );
      expect(emitter.emit).toHaveBeenCalledWith('refund.recorded', expect.any(Object));
    });

    it('books a refund the gateway reports DECLINED as FAILED — the positive signal the legacy path never had', async () => {
      const refund = tapRefund();
      arrange(refund, { status: 'failed', failureReason: 'Refund was rejected by the payment gateway' });

      const summary = await service.reapStalePending();

      expect(summary.failed).toBe(1);
      expect(refunds.save).toHaveBeenCalledWith(expect.objectContaining({ status: REFUND_STATUS.FAILED }));
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it.each(['pending', 'unknown'])('leaves the refund PENDING when the gateway says %s (never guessed)', async (status) => {
      const refund = tapRefund();
      arrange(refund, { status });

      const summary = await service.reapStalePending();

      expect(summary.stillPending).toBe(1);
      expect(refunds.save).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('never books a refund object that belongs to another charge — and RECORDS it for a human', async () => {
      const refund = tapRefund();
      arrange(refund, { status: 'succeeded', gatewayPaymentId: 'chg_OTHER' });

      const summary = await service.reapStalePending();

      expect(summary.succeeded).toBe(0);
      expect(summary.stillPending).toBe(1);
      expect(refunds.save).not.toHaveBeenCalled();
      expect(exceptions.raiseQuietly).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'REFUND_MISMATCH',
          provider: 'tap',
          objectId: 're_tap_1',
          paymentId: 'pay-1',
          details: expect.objectContaining({
            source: 'refund_reaper',
            refundId: 'rf-1',
            expectedChargeId: 'chg_1',
            reportedChargeId: 'chg_OTHER',
          }),
        }),
      );
    });

    it('never books a refund whose amount differs from ours', async () => {
      const refund = tapRefund();
      arrange(refund, { status: 'succeeded', amountMinorUnits: 9999 });

      const summary = await service.reapStalePending();

      expect(summary.succeeded).toBe(0);
      expect(refunds.save).not.toHaveBeenCalled();
    });

    it('a provider-settled payment records NO internal clawback when refunded', async () => {
      const refund = tapRefund({
        payment: {
          id: 'pay-1', amount: 100, currency: 'SAR', gateway: 'tap', gateway_payment_id: 'chg_1',
          settlement_status: 'SETTLED', settlement_mode: 'PROVIDER',
        },
      });
      arrange(refund, { status: 'succeeded' });
      paymentsRepo.findOne.mockReset();
      paymentsRepo.findOne.mockResolvedValueOnce({ ...refund.payment });

      await service.reapStalePending();

      expect(adjustments.recordClawbackIfSettled).not.toHaveBeenCalled();
    });

    describe('no gateway refund id (the create call never answered)', () => {
      const noId = () => tapRefund({ gateway_refund_id: undefined });

      it('re-sends the SAME per-refund request inside the replay window, then learns the id', async () => {
        const refund = noId();
        arrange(refund);
        (dataSource as any).query.mockResolvedValue([{ age: String(60 * 60_000) }]); // 1h old
        provider.refundPayment.mockResolvedValue({
          success: false,
          status: 'pending',
          gatewayRefundId: 're_tap_9',
          gatewayPaymentId: 'chg_1',
          amountMinorUnits: 6000,
          currency: 'SAR',
        });

        const summary = await service.reapStalePending();

        expect(provider.verifyRefund).not.toHaveBeenCalled();
        expect(provider.refundPayment).toHaveBeenCalledWith(
          expect.objectContaining({ refundId: 'rf-1', gatewayPaymentId: 'chg_1', amount: 0.6 * 100, currency: 'SAR' }),
        );
        expect(summary.stillPending).toBe(1);
        const qb = (refunds as any).createQueryBuilder.mock.results[0].value;
        expect(qb.set).toHaveBeenCalledWith({ gateway_refund_id: 're_tap_9' });
      });

      it('does NOT re-send past the replay window — that would be a second refund — and leaves it for an operator', async () => {
        const refund = noId();
        arrange(refund);
        (dataSource as any).query.mockResolvedValue([{ age: String(13 * 60 * 60_000) }]); // 13h old

        const summary = await service.reapStalePending();

        expect(provider.refundPayment).not.toHaveBeenCalled();
        expect(summary.stillPending).toBe(1);
        expect(refunds.save).not.toHaveBeenCalled();
      });

      it('does NOT re-send when the age cannot be read (fail safe)', async () => {
        const refund = noId();
        arrange(refund);
        (dataSource as any).query.mockResolvedValue([]);

        await service.reapStalePending();

        expect(provider.refundPayment).not.toHaveBeenCalled();
      });
    });
  });
});
