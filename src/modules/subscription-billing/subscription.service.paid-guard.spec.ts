import { SubscriptionService } from './subscription.service';
import { SubscriptionStatus } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';

/**
 * FIN-004 — a paid plan must never go ACTIVE without a payment, in any environment
 * or billing mode, when no provider can take a checkout.
 */
describe('SubscriptionService — paid-plan guard (FIN-004)', () => {
  const paidPlan = {
    id: 'p1',
    is_active: true,
    price: 300,
    billing_cycle: 'MONTHLY',
  };

  const build = (opts: {
    env: string;
    paidMode: boolean;
    supportsCheckout: boolean;
    allowStub?: boolean;
  }) => {
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
      {
        get: jest.fn((k: string) =>
          k === 'NODE_ENV'
            ? opts.env
            : k === 'SUBSCRIPTION_ALLOW_UNPAID_STUB'
              ? opts.allowStub
              : 14,
        ),
      } as any,
      { isPaidMode: jest.fn().mockResolvedValue(opts.paidMode) } as any,
    );
    // The guard runs before any persistence; the view/read path is not under test.
    (svc as any).getActivePlan = jest.fn().mockResolvedValue(paidPlan);
    (svc as any).withBilling = jest.fn(async (v: unknown) => v);
    (svc as any).loadWithPlan = jest.fn().mockResolvedValue({});
    (svc as any).view = jest
      .fn()
      .mockReturnValue({ status: SubscriptionStatus.ACTIVE });
    return { svc, subscriptions, billing };
  };

  it('refuses a paid plan in production + PAID mode when no checkout exists', async () => {
    const { svc, subscriptions, billing } = build({
      env: 'production',
      paidMode: true,
      supportsCheckout: false,
    });
    await expect(
      svc.create('t1', { planId: 'p1' } as any),
    ).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
    expect(subscriptions.save).not.toHaveBeenCalled();
    expect(billing.generateInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ['production', true],
    ['production', false],
    ['staging', true],
    ['staging', false],
    ['development', true],
    ['development', false],
  ])(
    'refuses a paid plan in %s (paidMode=%s) with no checkout provider',
    async (env, paidMode) => {
      const { svc, subscriptions, billing } = build({
        env,
        paidMode,
        supportsCheckout: false,
      });
      await expect(
        svc.create('t1', { planId: 'p1' } as any),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(subscriptions.save).not.toHaveBeenCalled();
      expect(billing.generateInvoice).not.toHaveBeenCalled();
    },
  );

  it('change-plan to a paid plan is refused with no checkout provider (no switch, no invoice)', async () => {
    const { svc, subscriptions, billing } = build({
      env: 'production',
      paidMode: false,
      supportsCheckout: false,
    });
    (svc as any).getActiveSubscription = jest.fn().mockResolvedValue({
      id: 'sub1',
      status: SubscriptionStatus.ACTIVE,
      plan: { id: 'free-plan', price: 0 },
      pending_plan: null,
    });
    await expect(
      svc.changePlan('t1', { planId: 'p1' } as any),
    ).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
    expect(subscriptions.save).not.toHaveBeenCalled();
    expect(billing.generateInvoice).not.toHaveBeenCalled();
  });

  it('reactivating a paid plan is refused with no checkout provider (stays lapsed)', async () => {
    const { svc, subscriptions, billing } = build({
      env: 'production',
      paidMode: false,
      supportsCheckout: false,
    });
    subscriptions.findOne.mockResolvedValue({
      id: 'sub1',
      status: SubscriptionStatus.CANCELLED,
      plan: paidPlan,
    });
    await expect(svc.reactivate('t1')).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
    expect(subscriptions.save).not.toHaveBeenCalled();
    expect(billing.generateInvoice).not.toHaveBeenCalled();
  });

  it('a FREE plan is unaffected with no checkout provider', async () => {
    const { svc, subscriptions } = build({
      env: 'production',
      paidMode: true,
      supportsCheckout: false,
    });
    (svc as any).getActivePlan = jest
      .fn()
      .mockResolvedValue({ ...paidPlan, price: 0 });
    await svc.create('t1', { planId: 'p1' } as any);
    expect(subscriptions.save).toHaveBeenCalled();
  });

  it('allows the explicit local opt-in outside production only', async () => {
    const dev = build({
      env: 'development',
      paidMode: true,
      supportsCheckout: false,
      allowStub: true,
    });
    await dev.svc.create('t1', { planId: 'p1' } as any);
    expect(dev.subscriptions.save).toHaveBeenCalled();

    const prod = build({
      env: 'production',
      paidMode: true,
      supportsCheckout: false,
      allowStub: true,
    });
    await expect(
      prod.svc.create('t1', { planId: 'p1' } as any),
    ).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
    expect(prod.subscriptions.save).not.toHaveBeenCalled();
  });

  it('a paid plan with a checkout provider waits as PENDING_PAYMENT with an INITIAL invoice', async () => {
    const { svc, subscriptions, billing } = build({
      env: 'production',
      paidMode: false,
      supportsCheckout: true,
    });
    await svc.create('t1', { planId: 'p1' } as any);
    expect(subscriptions.save.mock.calls[0][0].status).toBe(
      SubscriptionStatus.PENDING_PAYMENT,
    );
    expect(billing.generateInvoice.mock.calls[0][3]).toBeInstanceOf(Date);
    expect(billing.generateInvoice.mock.calls[0][7]).toMatchObject({
      kind: 'INITIAL',
    });
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
    const { svc } = build({
      env: 'production',
      paidMode: true,
      supportsCheckout: false,
    });
    await expect(
      svc.create('t1', { planId: 'p1', startTrial: true } as any),
    ).resolves.toBeDefined();
  });
});
