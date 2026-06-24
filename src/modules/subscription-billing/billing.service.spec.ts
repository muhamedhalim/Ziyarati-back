import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BillingService } from './billing.service';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { PAYMENT_PROVIDER } from './payment/payment-provider.interface';
import { InvoiceStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('BillingService', () => {
  let service: BillingService;
  let invoices: MockRepository;
  let payment: { charge: jest.Mock };

  beforeEach(async () => {
    invoices = createMockRepository();
    payment = { charge: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: getRepositoryToken(SubscriptionInvoice), useValue: invoices },
        { provide: PAYMENT_PROVIDER, useValue: payment },
      ],
    }).compile();
    service = moduleRef.get(BillingService);
  });

  afterEach(() => jest.clearAllMocks());

  it('generates an OPEN invoice with a 2-dp amount', async () => {
    invoices.save.mockImplementationOnce(async (i: any) => i);
    const inv = await service.generateInvoice(TENANT, 'sub1', 99.5);
    expect(inv).toMatchObject({ amount: '99.50', status: InvoiceStatus.OPEN });
  });

  it('getInvoice throws when not found', async () => {
    invoices.findOne.mockResolvedValueOnce(null);
    await expect(service.getInvoice(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  describe('payInvoice', () => {
    it('charges the provider and marks the invoice PAID on success', async () => {
      invoices.findOne.mockResolvedValueOnce({ id: 'inv1', status: InvoiceStatus.OPEN, amount: '100' });
      payment.charge.mockResolvedValueOnce({ success: true });
      invoices.save.mockImplementationOnce(async (i: any) => i);
      const res = await service.payInvoice(TENANT, 'inv1');
      expect(res.status).toBe(InvoiceStatus.PAID);
      expect(res.paid_at).toBeInstanceOf(Date);
    });

    it('rejects an already-paid invoice', async () => {
      invoices.findOne.mockResolvedValueOnce({ id: 'inv1', status: InvoiceStatus.PAID });
      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('rejects a void/refunded invoice with 422', async () => {
      invoices.findOne.mockResolvedValueOnce({ id: 'inv1', status: InvoiceStatus.VOID });
      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('surfaces a provider decline as 422', async () => {
      invoices.findOne.mockResolvedValueOnce({ id: 'inv1', status: InvoiceStatus.OPEN, amount: '100' });
      payment.charge.mockResolvedValueOnce({ success: false, failureReason: 'card declined' });
      await expect(service.payInvoice(TENANT, 'inv1')).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });
  });

  it('getSummary aggregates invoices by status', async () => {
    const qb = createMockQueryBuilder();
    qb.getRawMany.mockResolvedValueOnce([
      { status: InvoiceStatus.PAID, count: '2', total: '200' },
      { status: InvoiceStatus.OPEN, count: '1', total: '50' },
    ]);
    invoices.createQueryBuilder.mockReturnValueOnce(qb);
    const summary = await service.getSummary(TENANT);
    expect(summary.totalInvoices).toBe(3);
    expect(summary.totalPaid).toBe(200);
    expect(summary.totalOutstanding).toBe(50);
  });
});
