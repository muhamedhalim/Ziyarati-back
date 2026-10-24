import { RefundService } from './refund.service';
import { TransactionService } from './transaction.service';
import { InvoiceService } from './invoice.service';

/**
 * FIN-X7 / Phase 3 — what the clinic's payments tabs receive. The clinic sees the
 * currency of the payment a refund or a log entry belongs to, never the payment
 * row itself or the gateway's raw response; an invoice list names its customer
 * and nothing more about them.
 */
describe('clinic list projections (payments tabs)', () => {
  const PAYMENT = {
    id: 'pay-1',
    currency: 'USD',
    status: 'PAID',
    gateway_payment_id: 'chg_secret',
    metadata: { internal: true },
    failure_reason: 'raw gateway text',
    provider_recipient_id: 'merchant_x',
  };

  it('refund list: payment is reduced to {id, currency, status}', async () => {
    const repo = {
      findAndCount: jest.fn().mockResolvedValue([
        [{ id: 'r1', amount: 5, payment: PAYMENT }],
        1,
      ]),
    };
    const svc = new RefundService(repo as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const res = await svc.list('t1', { page: 1, limit: 10 } as any);
    expect(res.data[0].payment).toEqual({ id: 'pay-1', currency: 'USD', status: 'PAID' });
    expect(JSON.stringify(res)).not.toContain('chg_secret');
    expect(JSON.stringify(res)).not.toContain('merchant_x');
  });

  it('single refund read is projected the same way', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue({ id: 'r1', payment: PAYMENT }) };
    const svc = new RefundService(repo as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const res = await svc.findOneForClient('t1', 'r1');
    expect(res.payment).toEqual({ id: 'pay-1', currency: 'USD', status: 'PAID' });
  });

  it('transaction list drops raw_response and reduces the payment to {id, currency}', async () => {
    const repo = {
      findAndCount: jest.fn().mockResolvedValue([
        [{ id: 'x1', type: 'charge', raw_response: { card: '4242' }, payment: PAYMENT }],
        1,
      ]),
    };
    const svc = new TransactionService(repo as any);
    const res = await svc.list('t1', { page: 1, limit: 10 } as any);
    expect(res.data[0]).not.toHaveProperty('raw_response');
    expect(res.data[0].payment).toEqual({ id: 'pay-1', currency: 'USD' });
  });

  it('invoice list loads the customer but exposes only id and full_name', async () => {
    const repo = {
      findAndCount: jest.fn().mockResolvedValue([
        [
          {
            id: 'i1',
            customer: { id: 'c1', full_name: 'Sara', phone: '+966500000000', email: 'a@b.c' },
          },
          { id: 'i2', customer: null },
        ],
        2,
      ]),
    };
    const svc = new InvoiceService(repo as any, {} as any, {} as any, {} as any, {} as any);
    const res = await svc.list('t1', { page: 1, limit: 10 } as any);
    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ relations: { customer: true } }),
    );
    expect(res.data[0].customer).toEqual({ id: 'c1', full_name: 'Sara' });
    expect(res.data[1].customer).toBeNull();
  });
});
