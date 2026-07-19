import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentReconciliationService } from './payment-reconciliation.service';
import { Payment } from '../../entities/Payments/Payment';
import { PaymentStatus } from '../../entities/enums';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { PaymentsConfig } from './payments.config';
import { PaymentSucceededEvent } from '../../events/payment.events';
import {
  createMockConfigService,
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

describe('PaymentReconciliationService (webhook-loss recovery)', () => {
  let service: PaymentReconciliationService;
  let payments: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let gateway: { verifyPayment: jest.Mock };
  let emitter: { emit: jest.Mock };

  const stalePending = () => ({
    id: 'pay-1',
    amount: 100,
    currency: 'SAR',
    status: PaymentStatus.PENDING,
    gateway: 'moyasar',
    gateway_payment_id: 'gw-1',
    created_at: new Date(Date.now() - 60 * 60_000),
    tenant: { id: 't1' },
    customer: { id: 'cust-1' },
    appointment: { id: 'appt-1' },
  });

  const lockedRepo = () => manager.getRepository(Payment) as unknown as MockRepository;

  beforeEach(async () => {
    payments = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    gateway = { verifyPayment: jest.fn() };
    emitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentReconciliationService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentGatewayFactory, useValue: { resolve: jest.fn().mockReturnValue(gateway) } },
        { provide: TransactionService, useValue: { record: jest.fn() } },
        {
          provide: PaymentFinancialsService,
          useValue: { applyOnPaid: jest.fn(), extractFromRaw: jest.fn().mockReturnValue({}) },
        },
        {
          provide: PaymentsConfig,
          useValue: new PaymentsConfig(createMockConfigService() as unknown as ConfigService),
        },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = moduleRef.get(PaymentReconciliationService);
  });

  afterEach(() => jest.clearAllMocks());

  it('recovers a missing "paid" webhook: books PAID and emits the succeeded event', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 10000,
      capturedCurrency: 'SAR',
      raw: {},
    });
    const locked = { ...stalePending() };
    lockedRepo().findOne.mockResolvedValueOnce(locked);

    const summary = await service.reconcileStalePending();
    expect(summary).toMatchObject({ scanned: 1, markedPaid: 1, mismatches: 0 });
    expect(locked.status).toBe(PaymentStatus.PAID);
    expect(emitter.emit).toHaveBeenCalledWith(
      PaymentSucceededEvent.eventName,
      expect.objectContaining({ paymentId: 'pay-1', appointmentId: 'appt-1' }),
    );
  });

  it('marks FAILED when the gateway positively reports failure', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'failed',
      failureReason: 'expired',
      raw: {},
    });
    const locked = { ...stalePending() };
    lockedRepo().findOne.mockResolvedValueOnce(locked);

    const summary = await service.reconcileStalePending();
    expect(summary.markedFailed).toBe(1);
    expect(locked.status).toBe(PaymentStatus.FAILED);
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('NEVER auto-books an amount mismatch — counts it for manual review', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 9000, // underpaid
      capturedCurrency: 'SAR',
      raw: {},
    });

    const summary = await service.reconcileStalePending();
    expect(summary.mismatches).toBe(1);
    expect(summary.markedPaid).toBe(0);
    expect(dataSource.transaction).not.toHaveBeenCalled(); // left PENDING untouched
  });

  it('NEVER auto-books a currency mismatch', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 10000,
      capturedCurrency: 'USD',
      raw: {},
    });

    const summary = await service.reconcileStalePending();
    expect(summary.mismatches).toBe(1);
    expect(summary.markedPaid).toBe(0);
  });

  it('leaves a still-pending gateway state for the next run', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({ success: true, status: 'pending', raw: {} });

    const summary = await service.reconcileStalePending();
    expect(summary.stillPending).toBe(1);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('no-ops when a webhook resolved the payment between phases (never regresses)', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockResolvedValueOnce({
      success: true,
      status: 'paid',
      capturedMinorUnits: 10000,
      capturedCurrency: 'SAR',
      raw: {},
    });
    lockedRepo().findOne.mockResolvedValueOnce({ ...stalePending(), status: PaymentStatus.PAID });

    const summary = await service.reconcileStalePending();
    expect(summary.markedPaid).toBe(0);
    expect(lockedRepo().save).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('survives a gateway error on one payment and keeps sweeping', async () => {
    payments.find.mockResolvedValueOnce([stalePending()]);
    gateway.verifyPayment.mockRejectedValueOnce(new Error('gateway unreachable'));
    const summary = await service.reconcileStalePending();
    expect(summary.stillPending).toBe(1);
  });
});
