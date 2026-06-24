import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaymentWebhookService } from './payment-webhook.service';
import { Payment } from '../../entities/Payments/Payment';
import { Refund } from '../../entities/Payments/Refund';
import { PaymentStatus } from '../../entities/enums';
import { MoyasarWebhookVerifier } from './webhooks/moyasar-webhook.verifier';
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  createMockQueryBuilder,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

describe('PaymentWebhookService.handleMoyasar', () => {
  let service: PaymentWebhookService;
  let payments: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let verifier: { verify: jest.Mock };
  let transactions: { recordWebhookOnce: jest.Mock; record: jest.Mock };
  let adjustments: { recordClawbackIfSettled: jest.Mock };

  const ownerPayment = () => ({ id: 'pay-1', status: PaymentStatus.PENDING, tenant: { id: 't1' } });
  const lockedPayment = () => ({
    id: 'pay-1',
    amount: 100,
    currency: 'SAR',
    status: PaymentStatus.PENDING,
    settlement_status: 'UNSETTLED',
  });

  beforeEach(async () => {
    payments = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    verifier = { verify: jest.fn().mockReturnValue(true) };
    transactions = {
      recordWebhookOnce: jest.fn().mockResolvedValue({ created: true }),
      record: jest.fn().mockResolvedValue(undefined),
    };
    adjustments = { recordClawbackIfSettled: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentWebhookService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: DataSource, useValue: dataSource },
        { provide: MoyasarWebhookVerifier, useValue: verifier },
        { provide: TransactionService, useValue: transactions },
        { provide: SettlementAdjustmentService, useValue: adjustments },
      ],
    }).compile();
    service = moduleRef.get(PaymentWebhookService);
  });

  afterEach(() => jest.clearAllMocks());

  const paymentRepo = () => manager.getRepository(Payment) as unknown as MockRepository;

  it('rejects a webhook with an invalid signature', async () => {
    verifier.verify.mockReturnValueOnce(false);
    await expect(
      service.handleMoyasar({ id: 'e1', type: 'payment_paid', data: { id: 'gw1' } } as any, 'bad'),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
  });

  it('accepts-but-ignores a webhook with no gateway payment id', async () => {
    const res = await service.handleMoyasar({ id: 'e1', type: 'x', data: {} } as any);
    expect(res).toEqual({ accepted: true, matched: false });
  });

  it('accepts-but-ignores a webhook for an unknown gateway payment', async () => {
    payments.findOne.mockResolvedValueOnce(null);
    const res = await service.handleMoyasar({ id: 'e1', type: 'x', data: { id: 'gw-unknown' } } as any);
    expect(res).toEqual({ accepted: true, matched: false });
  });

  it('deduplicates a redelivered webhook (no state change)', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    paymentRepo().findOne.mockResolvedValueOnce(lockedPayment());
    transactions.recordWebhookOnce.mockResolvedValueOnce({ created: false }); // lost the insert race

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_paid',
      data: { id: 'gw1', status: 'paid', amount: 10000, currency: 'SAR' },
    } as any);

    expect(res.deduplicated).toBe(true);
    expect(paymentRepo().save).not.toHaveBeenCalled();
  });

  it('marks a payment PAID when the captured amount and currency match', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_paid',
      data: { id: 'gw1', status: 'paid', amount: 10000, currency: 'SAR' },
    } as any);

    expect(payment.status).toBe(PaymentStatus.PAID);
    expect(res.status).toBe(PaymentStatus.PAID);
    expect(paymentRepo().save).toHaveBeenCalledWith(payment);
  });

  it('REFUSES to flip to PAID when the captured amount mismatches (anti-tampering)', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_paid',
      data: { id: 'gw1', status: 'paid', amount: 9999, currency: 'SAR' }, // wrong amount
    } as any);

    expect(payment.status).toBe(PaymentStatus.PENDING); // untouched
    expect(res.status).toBe(PaymentStatus.PENDING);
    expect(paymentRepo().save).not.toHaveBeenCalled();
  });

  it('marks a PENDING payment FAILED on a failure event', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_failed',
      data: { id: 'gw1', status: 'failed' },
    } as any);

    expect(res.status).toBe(PaymentStatus.FAILED);
  });

  it('reconciles a refund against the ledger and recomputes the payment status', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    // sumRefundsCents is called twice: baseline (SUCCEEDED+PENDING)=0, then SUCCEEDED total=10000c.
    const refundQb = createMockQueryBuilder();
    refundQb.getRawOne
      .mockResolvedValueOnce({ sum: '0' })
      .mockResolvedValueOnce({ sum: '100' }); // 100 major == 10000 cents == full
    manager.createQueryBuilder.mockReturnValue(refundQb);

    const res = await service.handleMoyasar({
      id: 'e1',
      type: 'payment_refunded',
      data: { id: 'gw1', refunded: 10000 },
    } as any);

    // A reconciling Refund row is appended for the delta and clawback is checked.
    expect(manager.getRepository(Refund).save).toHaveBeenCalled();
    expect(adjustments.recordClawbackIfSettled).toHaveBeenCalled();
    expect(res.status).toBe(PaymentStatus.REFUNDED);
  });

  it('does not append a refund when the gateway total already matches the ledger (no delta)', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    paymentRepo().findOne.mockResolvedValueOnce({ ...lockedPayment(), status: PaymentStatus.REFUNDED });

    const refundQb = createMockQueryBuilder();
    refundQb.getRawOne
      .mockResolvedValueOnce({ sum: '100' }) // baseline already 10000c
      .mockResolvedValueOnce({ sum: '100' }); // succeeded 10000c
    manager.createQueryBuilder.mockReturnValue(refundQb);

    await service.handleMoyasar({
      id: 'e1',
      type: 'payment_refunded',
      data: { id: 'gw1', refunded: 10000 },
    } as any);

    expect(manager.getRepository(Refund).save).not.toHaveBeenCalled();
    expect(adjustments.recordClawbackIfSettled).not.toHaveBeenCalled();
  });

  it('logs the raw event (no dedup) when the webhook carries no event id', async () => {
    payments.findOne.mockResolvedValueOnce(ownerPayment());
    const payment = lockedPayment();
    paymentRepo().findOne.mockResolvedValueOnce(payment);

    const res = await service.handleMoyasar({
      type: 'payment_paid',
      data: { id: 'gw1', status: 'paid', amount: 10000, currency: 'SAR' },
    } as any);

    expect(transactions.record).toHaveBeenCalled();
    expect(transactions.recordWebhookOnce).not.toHaveBeenCalled();
    expect(res.status).toBe(PaymentStatus.PAID);
  });
});
