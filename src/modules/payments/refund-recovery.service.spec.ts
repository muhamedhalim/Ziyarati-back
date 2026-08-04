import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
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

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RefundRecoveryService,
        { provide: getRepositoryToken(Refund), useValue: refunds },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentGatewayFactory, useValue: gateways },
        { provide: TransactionService, useValue: transactions },
        { provide: SettlementAdjustmentService, useValue: adjustments },
        { provide: ConfigService, useValue: createMockConfigService() },
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
});
