import { PaymentFinancialsService } from './payment-financials.service';
import { Payment } from '../../entities/Payments/Payment';

const service = (env: Record<string, unknown> = {}) =>
  new PaymentFinancialsService({
    get: (key: string) => env[key],
  } as never);

const payment = (over: Partial<Payment> = {}): Payment =>
  ({
    amount: 100,
    gateway_fee: 0,
    platform_fee: 0,
    ...over,
  }) as Payment;

describe('PaymentFinancialsService.applyOnPaid — fee finality (Tap Phase 2)', () => {
  it('stamps fees_reconciled_at when the gateway REPORTED a fee at capture (the figure is final)', () => {
    const p = payment();
    service().applyOnPaid(p, { gatewayFee: 2.5 });
    expect(p.gateway_fee).toBe(2.5);
    expect(p.net_amount).toBe(97.5);
    expect(p.fees_reconciled_at).toBeInstanceOf(Date);
  });

  it('stamps it for a reported fee of zero too — "the gateway said 0" is a fact, not an absence', () => {
    const p = payment();
    service().applyOnPaid(p, { gatewayFee: 0 });
    expect(p.fees_reconciled_at).toBeInstanceOf(Date);
  });

  it('leaves it NULL (provisional) when the gateway reported no fee — a Tap charge carries none', () => {
    const p = payment();
    service().applyOnPaid(p, {});
    expect(p.gateway_fee).toBe(0);
    expect(p.net_amount).toBe(100); // net = gross until reconciliation fills the real fee
    expect(p.fees_reconciled_at ?? null).toBeNull();
  });

  it('leaves it NULL when called with no input at all', () => {
    const p = payment();
    service().applyOnPaid(p);
    expect(p.fees_reconciled_at ?? null).toBeNull();
  });

  it('never moves an already-stamped figure (a replayed capture must not look newer)', () => {
    const stamped = new Date('2026-01-01T00:00:00Z');
    const p = payment({ fees_reconciled_at: stamped });
    service().applyOnPaid(p, { gatewayFee: 3 });
    expect(p.fees_reconciled_at).toBe(stamped);
  });

  it('does not stamp from a fee already sitting on the row — only a figure reported NOW is final', () => {
    const p = payment({ gateway_fee: 4 });
    service().applyOnPaid(p, {});
    expect(p.gateway_fee).toBe(4);
    expect(p.fees_reconciled_at ?? null).toBeNull();
  });

  it('keeps net = gross − gateway fee − platform fee', () => {
    const p = payment();
    service({ PLATFORM_FEE_PERCENT: 2, PLATFORM_FEE_FIXED: 1 }).applyOnPaid(p, {
      gatewayFee: 1.5,
    });
    expect(p.platform_fee).toBe(3);
    expect(p.net_amount).toBe(95.5);
  });
});
