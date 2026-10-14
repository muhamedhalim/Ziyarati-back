import { SubscriptionService } from './subscription.service';
import { SubscriptionStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';

/**
 * FIN-004 — a paid plan must not go ACTIVE without a payment in production /
 * PAID billing mode when no provider can take a checkout.
 */
describe('SubscriptionService — paid-plan guard (FIN-004)', () => {
  const paidPlan = { id: 'p1', is_active: true, price: 300, billing_cycle: 'MONTHLY' };

  const build = (opts: { env: string; paidMode: boolean; supportsCheckout: boolean }) => {
    const subscriptions: any = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn(async (s: any) => ({ id: 'sub1', ...s })),
      create: jest.fn((s: any) => s),
    };
    const plans: any = { findOne: jest.fn().mockResolvedValue(paidPlan) };
    const billing: any = {
      supportsCheckout: opts.supportsCheckout,
      providerName: 'stub',
      generateInvoice: jest.fn().mockResolvedValue({ id: 'inv' }),
    };
    const svc = new SubscriptionService(
      subscriptions,
      plans,
      billing,
      { invalidate: jest.fn() } as any,
      { getTyped: jest.fn().mockResolvedValue('SAR') } as any,
      { emit: jest.fn() } as any,
      { get: jest.fn((k: string) => (k === 'NODE_ENV' ? opts.env : 14)) } as any,
      { isPaidMode: jest.fn().mockResolvedValue(opts.paidMode) } as any,
    );
    // The guard runs before any persistence; the view/read path is not under test.
    (svc as any).getActivePlan = jest.fn().mockResolvedValue(paidPlan);
    (svc as any).withBilling = jest.fn(async (v: unknown) => v);
    (svc as any).loadWithPlan = jest.fn().mockResolvedValue({});
    (svc as any).view = jest.fn().mockReturnValue({ status: SubscriptionStatus.ACTIVE });
    return { svc, subscriptions, billing };
  };

  it('refuses a paid plan in production + PAID mode when no checkout exists', async () => {
    const { svc, subscriptions, billing } = build({
      env: 'production',
      paidMode: true,
      supportsCheckout: false,
    });
    await expect(svc.create('t1', { planId: 'p1' } as any)).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
    });
    expect(subscriptions.save).not.toHaveBeenCalled();
    expect(billing.generateInvoice).not.toHaveBeenCalled();
  });

  it('keeps the legacy behaviour outside production', async () => {
    const { svc, subscriptions } = build({
      env: 'development',
      paidMode: true,
      supportsCheckout: false,
    });
    await svc.create('t1', { planId: 'p1' } as any);
    expect(subscriptions.save).toHaveBeenCalled();
  });

  it('keeps the legacy behaviour in FREE billing mode', async () => {
    const { svc, subscriptions } = build({
      env: 'production',
      paidMode: false,
      supportsCheckout: false,
    });
    await svc.create('t1', { planId: 'p1' } as any);
    expect(subscriptions.save).toHaveBeenCalled();
  });

  it('does not interfere when a checkout-capable provider exists', async () => {
    const { svc, subscriptions } = build({
      env: 'production',
      paidMode: true,
      supportsCheckout: true,
    });
    await svc.create('t1', { planId: 'p1' } as any);
    expect(subscriptions.save).toHaveBeenCalled();
  });

  it('never blocks a trial', async () => {
    const { svc } = build({ env: 'production', paidMode: true, supportsCheckout: false });
    await expect(
      svc.create('t1', { planId: 'p1', startTrial: true } as any),
    ).resolves.toBeDefined();
  });
});
