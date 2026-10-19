import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SubscriptionService } from './subscription.service';
import { BillingService } from './billing.service';
import { AccessControlService } from './access-control.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import {
  BillingCycle,
  InvoiceStatus,
  SubscriptionInvoiceKind,
  SubscriptionStatus,
} from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  SubscriptionActivatedEvent,
  SubscriptionCancelledEvent,
  SubscriptionPlanChangedEvent,
  SubscriptionReactivatedEvent,
  SubscriptionTrialStartedEvent,
} from '../../events/subscription.events';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const future = new Date(Date.now() + 30 * 86_400_000);
const past = new Date(Date.now() - 86_400_000);

describe('SubscriptionService', () => {
  let service: SubscriptionService;
  let subscriptions: MockRepository;
  let plans: MockRepository;
  let billing: {
    supportsCheckout: boolean;
    providerName: string;
    generateInvoice: jest.Mock;
    findOpenInvoice: jest.Mock;
    voidOpenInvoices: jest.Mock;
    voidSupersededOpenInvoices: jest.Mock;
    isPaymentInFlight: jest.Mock;
    reconcileHostedCheckout: jest.Mock;
  };
  let access: { assertUsable: jest.Mock; invalidate: jest.Mock };
  let emitter: { emit: jest.Mock };

  const plan = (overrides = {}) => ({
    id: 'p1',
    is_active: true,
    price: 100,
    billing_cycle: BillingCycle.MONTHLY,
    ...overrides,
  });

  /** The ONE in-memory subscription every `findOne` returns: the service mutates it in place. */
  const liveSub = (overrides: Record<string, unknown> = {}) => {
    const sub: Record<string, any> = {
      id: 'sub1',
      status: SubscriptionStatus.ACTIVE,
      starts_at: past,
      ends_at: future,
      auto_renew: true,
      plan: plan(),
      pending_plan: null,
      grace_started_at: null,
      grace_expired_at: null,
      ...overrides,
    };
    subscriptions.findOne.mockImplementation(async () => sub);
    // A guarded UPDATE lands on this row, as the database would apply it.
    subscriptions.createQueryBuilder.mockImplementation(() => {
      const qb = createMockQueryBuilder();
      let fields: Record<string, unknown> = {};
      (qb.set as jest.Mock).mockImplementation((f: Record<string, unknown>) => {
        fields = f;
        return qb;
      });
      (qb.execute as jest.Mock).mockImplementation(async () => {
        Object.assign(sub, fields);
        return { affected: 1, raw: [] };
      });
      lastUpdate = qb;
      return qb;
    });
    return sub;
  };
  let lastUpdate: MockQueryBuilder | undefined;

  beforeEach(async () => {
    subscriptions = createMockRepository();
    // T046 (015-db-api-efficiency-audit, P7-2/ORM-001): getCurrent reads the
    // tenant FK column via entity metadata (R-11 — Subscription exposes no plain
    // `tenantId` property). `tenantId` matches the real column name.
    (subscriptions as unknown as { metadata: unknown }).metadata = {
      name: 'Subscription',
      findRelationWithPropertyPath: (path: string) =>
        path === 'tenant'
          ? { joinColumns: [{ databaseName: 'tenantId' }] }
          : undefined,
    };
    plans = createMockRepository();
    billing = {
      supportsCheckout: false, // the legacy world unless a test opts in
      providerName: 'tap',
      generateInvoice: jest.fn().mockResolvedValue({ id: 'inv-new' }),
      findOpenInvoice: jest.fn().mockResolvedValue(null),
      voidOpenInvoices: jest.fn().mockResolvedValue(0),
      voidSupersededOpenInvoices: jest.fn().mockResolvedValue(0),
      isPaymentInFlight: jest.fn().mockReturnValue(false),
      reconcileHostedCheckout: jest.fn().mockResolvedValue('none'),
    };
    access = {
      assertUsable: jest.fn().mockResolvedValue(undefined),
      // Every lifecycle transition busts the tenant's cached decisions — a plan
      // change alters both entitlement and quota policy.
      invalidate: jest.fn(),
    };
    emitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: getRepositoryToken(SubscriptionPlan), useValue: plans },
        { provide: BillingService, useValue: billing },
        { provide: AccessControlService, useValue: access },
        {
          provide: SystemSettingService,
          useValue: {
            getTyped: jest.fn(async (key: string) =>
              /currency/i.test(key) ? 'SAR' : 14,
            ),
          },
        },
        { provide: EventEmitter2, useValue: emitter },
        {
          provide: ConfigService,
          // NODE_ENV=test is the guard's explicit exemption: the legacy (no-checkout) tests below
          // exercise that path on purpose.
          useValue: {
            get: jest.fn((k: string) => (k === 'NODE_ENV' ? 'test' : 14)),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(SubscriptionService);
  });

  afterEach(() => jest.clearAllMocks());

  const emitted = (EventClass: { eventName: string }) =>
    emitter.emit.mock.calls.filter(([name]) => name === EventClass.eventName);

  // ───────────────────────────────── create ─────────────────────────────── //

  describe('create', () => {
    const created = (status: SubscriptionStatus) => {
      subscriptions.save.mockResolvedValueOnce({ id: 'sub1' });
      subscriptions.findOne
        .mockResolvedValueOnce(null) // no existing subscription
        .mockResolvedValueOnce({
          id: 'sub1',
          status,
          ends_at: future,
          plan: plan(),
        });
    };

    it('creates a paid subscription ACTIVE and issues a legacy (kind-less) first invoice when no provider can check out', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      created(SubscriptionStatus.ACTIVE);

      const res = await service.create(TENANT, { planId: 'p1' } as any);

      expect(billing.generateInvoice).toHaveBeenCalledWith(
        TENANT,
        'sub1',
        100,
        expect.any(Date),
        expect.any(Date),
        'SAR',
        InvoiceStatus.OPEN,
        {},
      );
      expect(res.isUsable).toBe(true);
      expect(emitted(SubscriptionActivatedEvent)).toHaveLength(1);
    });

    describe('D2 — a paid plan is ACTIVE only after payment (a provider that can check out is bound)', () => {
      beforeEach(() => {
        billing.supportsCheckout = true;
      });

      it('starts PENDING_PAYMENT with an INITIAL invoice for the plan, and activates nothing', async () => {
        plans.findOne.mockResolvedValueOnce(plan());
        created(SubscriptionStatus.PENDING_PAYMENT);
        billing.findOpenInvoice.mockResolvedValueOnce({
          id: 'inv-new',
          kind: SubscriptionInvoiceKind.INITIAL,
          amount: '100.00',
          currency: 'SAR',
        });

        const res = await service.create(TENANT, { planId: 'p1' } as any);

        expect(subscriptions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            status: SubscriptionStatus.PENDING_PAYMENT,
          }),
        );
        expect(billing.generateInvoice).toHaveBeenCalledWith(
          TENANT,
          'sub1',
          100,
          expect.any(Date),
          expect.any(Date),
          'SAR',
          InvoiceStatus.OPEN,
          {
            kind: SubscriptionInvoiceKind.INITIAL,
            targetPlanId: 'p1',
            provider: 'tap',
          },
        );
        expect(res.isUsable).toBe(false);
        expect(res.accessState).toBe('pending-payment');
        expect(res.effectiveStatus).toBe(SubscriptionStatus.PENDING_PAYMENT);
        expect(res.openInvoice).toEqual(
          expect.objectContaining({ id: 'inv-new', kind: 'INITIAL' }),
        );
        // Nothing is activated until the invoice is paid (the settle path emits it).
        expect(emitted(SubscriptionActivatedEvent)).toHaveLength(0);
        expect(access.invalidate).toHaveBeenCalledWith(TENANT);
      });

      it('a trial is still a trial: no invoice, no payment, TRIAL', async () => {
        plans.findOne.mockResolvedValueOnce(plan());
        created(SubscriptionStatus.TRIAL);
        await service.create(TENANT, { planId: 'p1', startTrial: true } as any);
        expect(subscriptions.create).toHaveBeenCalledWith(
          expect.objectContaining({ status: SubscriptionStatus.TRIAL }),
        );
        expect(billing.generateInvoice).not.toHaveBeenCalled();
        expect(emitted(SubscriptionTrialStartedEvent)).toHaveLength(1);
      });

      it('FIN-005: a second trial for a tenant with any prior subscription is refused', async () => {
        plans.findOne.mockResolvedValueOnce(plan());
        subscriptions.count.mockResolvedValueOnce(1);
        await expect(
          service.create(TENANT, { planId: 'p1', startTrial: true } as any),
        ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
        expect(subscriptions.save).not.toHaveBeenCalled();
      });

      it('a FREE plan needs no payment: ACTIVE at once, as before', async () => {
        plans.findOne.mockResolvedValueOnce(plan({ price: 0 }));
        created(SubscriptionStatus.ACTIVE);
        await service.create(TENANT, { planId: 'p1' } as any);
        expect(subscriptions.create).toHaveBeenCalledWith(
          expect.objectContaining({ status: SubscriptionStatus.ACTIVE }),
        );
        expect(emitted(SubscriptionActivatedEvent)).toHaveLength(1);
        expect(billing.generateInvoice).toHaveBeenCalledWith(
          TENANT,
          'sub1',
          0,
          expect.any(Date),
          expect.any(Date),
          'SAR',
          InvoiceStatus.OPEN,
          {},
        );
      });
    });

    it('does not invoice a trial subscription', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      created(SubscriptionStatus.TRIAL);
      await service.create(TENANT, { planId: 'p1', startTrial: true } as any);
      expect(billing.generateInvoice).not.toHaveBeenCalled();
    });

    it('rejects an inactive plan with 422', async () => {
      plans.findOne.mockResolvedValueOnce(plan({ is_active: false }));
      await expect(
        service.create(TENANT, { planId: 'p1' } as any),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects when a subscription already exists (a PENDING_PAYMENT one counts)', async () => {
      plans.findOne.mockResolvedValueOnce(plan());
      subscriptions.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(
        service.create(TENANT, { planId: 'p1' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  // ─────────────────────────────── changePlan ───────────────────────────── //

  describe('changePlan — no provider can check out (legacy)', () => {
    it('switches at once, supersedes the open invoice, and invoices the new price for NOW (the old same-period invoice collided with the unique index)', async () => {
      const sub = liveSub({ plan: plan({ id: 'p1' }) });
      plans.findOne.mockResolvedValueOnce(plan({ id: 'p2', price: 200 }));

      const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

      expect(sub.plan).toEqual({ id: 'p2' });
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(billing.voidOpenInvoices).toHaveBeenCalledWith(
        'sub1',
        expect.stringContaining('plan change'),
      );
      const call = billing.generateInvoice.mock.calls[0];
      expect(call.slice(0, 3)).toEqual([TENANT, 'sub1', 200]);
      // period_start is the moment of change, never the subscription's existing period start
      expect((call[3] as Date).getTime()).toBeGreaterThan(past.getTime());
      expect(call[4]).toBe(future);
      expect(res.mode).toBe('switched');
      expect(emitted(SubscriptionPlanChangedEvent)).toHaveLength(1);
      expect(access.invalidate).toHaveBeenCalledWith(TENANT);
    });

    it('an already-lapsed period gets a fresh invoice period rather than an end before its start', async () => {
      liveSub({ plan: plan({ id: 'p1' }), ends_at: past });
      plans.findOne.mockResolvedValueOnce(plan({ id: 'p2', price: 200 }));
      await service.changePlan(TENANT, { planId: 'p2' } as any);
      const [, , , start, end] = billing.generateInvoice.mock
        .calls[0] as Date[];
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    });

    it('rejects changing to the same plan', async () => {
      liveSub({ plan: plan({ id: 'p1' }) });
      await expect(
        service.changePlan(TENANT, { planId: 'p1' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  describe('changePlan — D4 (a provider that can check out is bound)', () => {
    beforeEach(() => {
      billing.supportsCheckout = true;
    });

    const target = (over = {}) =>
      plans.findOne.mockResolvedValueOnce(
        plan({ id: 'p2', price: 200, ...over }),
      );

    it('UPGRADE: issues an UPGRADE invoice for the full new price and changes NOTHING until it is paid', async () => {
      const sub = liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      target();
      billing.generateInvoice.mockResolvedValueOnce({ id: 'inv-up' });

      const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

      expect(res.mode).toBe('checkout');
      expect(res.invoiceId).toBe('inv-up');
      expect(billing.generateInvoice).toHaveBeenCalledWith(
        TENANT,
        'sub1',
        200,
        expect.any(Date),
        expect.any(Date),
        'SAR',
        InvoiceStatus.OPEN,
        {
          kind: SubscriptionInvoiceKind.UPGRADE,
          targetPlanId: 'p2',
          provider: 'tap',
        },
      );
      expect(sub.plan.id).toBe('p1'); // nothing switches before payment
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(subscriptions.save).not.toHaveBeenCalled();
      expect(emitted(SubscriptionPlanChangedEvent)).toHaveLength(0);
    });

    it("the upgrade invoice starts NOW — it can never collide with the existing period's invoice", async () => {
      liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      target();
      await service.changePlan(TENANT, { planId: 'p2' } as any);
      const start = billing.generateInvoice.mock.calls[0][3] as Date;
      expect(Math.abs(start.getTime() - Date.now())).toBeLessThan(5_000);
    });

    it('TRIAL -> paid is an upgrade even when the price is not higher', async () => {
      liveSub({
        status: SubscriptionStatus.TRIAL,
        plan: plan({ id: 'p1', price: 500 }),
      });
      target({ price: 200 });
      const res = await service.changePlan(TENANT, { planId: 'p2' } as any);
      expect(res.mode).toBe('checkout');
      expect(billing.generateInvoice).toHaveBeenCalledWith(
        TENANT,
        'sub1',
        200,
        expect.any(Date),
        expect.any(Date),
        'SAR',
        InvoiceStatus.OPEN,
        expect.objectContaining({ kind: SubscriptionInvoiceKind.UPGRADE }),
      );
    });

    it('clicking the same upgrade again hands back the open invoice instead of issuing a second', async () => {
      liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      target();
      billing.findOpenInvoice.mockResolvedValue({
        id: 'inv-open',
        kind: SubscriptionInvoiceKind.UPGRADE,
        target_plan_id: 'p2',
      });

      const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

      expect(res).toMatchObject({ mode: 'checkout', invoiceId: 'inv-open' });
      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
    });

    it('re-quotes an idle upgrade for a DIFFERENT plan (voids the old quote, issues the new one)', async () => {
      liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      target();
      billing.findOpenInvoice.mockResolvedValue({
        id: 'inv-old',
        kind: SubscriptionInvoiceKind.UPGRADE,
        target_plan_id: 'p9',
      });
      billing.voidSupersededOpenInvoices.mockResolvedValueOnce(1);

      const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

      // The guarded void: it re-checks "nobody is paying it" in the same UPDATE.
      expect(billing.voidSupersededOpenInvoices).toHaveBeenCalledWith(
        'sub1',
        expect.stringContaining('quote'),
      );
      expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
      expect(res.mode).toBe('checkout');
      expect(billing.generateInvoice).toHaveBeenCalledTimes(1);
    });

    it('refuses to re-quote an upgrade a clinic is paying right now — a live charge must not point at a voided invoice', async () => {
      liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      target();
      billing.findOpenInvoice.mockResolvedValue({
        id: 'inv-old',
        kind: SubscriptionInvoiceKind.UPGRADE,
        target_plan_id: 'p9',
      });
      billing.isPaymentInFlight.mockReturnValue(true);

      await expect(
        service.changePlan(TENANT, { planId: 'p2' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
      expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
      expect(billing.generateInvoice).not.toHaveBeenCalled();
    });

    it.each([
      ['a renewal invoice', SubscriptionInvoiceKind.RENEWAL],
      ['a first-payment invoice', SubscriptionInvoiceKind.INITIAL],
      ['a reactivation invoice', SubscriptionInvoiceKind.REACTIVATION],
    ])(
      'refuses to upgrade while %s is open — it bills a real period, pay it first',
      async (_l, kind) => {
        liveSub({ plan: plan({ id: 'p1', price: 100 }) });
        target();
        billing.findOpenInvoice.mockResolvedValue({ id: 'inv-x', kind });
        await expect(
          service.changePlan(TENANT, { planId: 'p2' } as any),
        ).rejects.toMatchObject({
          code: ErrorCode.CONFLICT,
          publicContext: { invoiceId: 'inv-x', kind },
        });
        expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
        expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
        expect(billing.generateInvoice).not.toHaveBeenCalled();
      },
    );

    describe('auto-renew OFF (cancel at period end) — the subscription is still ACTIVE to ends_at', () => {
      const nonRenewing = () =>
        liveSub({ plan: plan({ id: 'p1', price: 100 }), auto_renew: false });

      it('a legacy invoice (kind NULL, no checkout) is superseded by the upgrade quote — it no longer blocks the change', async () => {
        const sub = nonRenewing();
        target();
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-legacy',
          kind: null,
          amount: '100.00',
        });
        billing.voidSupersededOpenInvoices.mockResolvedValueOnce(1);
        billing.generateInvoice.mockResolvedValueOnce({ id: 'inv-up' });

        const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

        expect(res).toMatchObject({ mode: 'checkout', invoiceId: 'inv-up' });
        expect(billing.voidSupersededOpenInvoices).toHaveBeenCalledWith(
          'sub1',
          expect.stringContaining('quote'),
        );
        expect(billing.generateInvoice).toHaveBeenCalledWith(
          TENANT,
          'sub1',
          200,
          expect.any(Date),
          expect.any(Date),
          'SAR',
          InvoiceStatus.OPEN,
          expect.objectContaining({ kind: SubscriptionInvoiceKind.UPGRADE }),
        );
        // Nothing switches before payment, and the clinic's auto-renew choice stays.
        expect(sub.plan.id).toBe('p1');
        expect(sub.auto_renew).toBe(false);
      });

      it('a free-plan invoice for 0.00 (kind NULL) is superseded as well', async () => {
        liveSub({ plan: plan({ id: 'pf', price: 0 }), auto_renew: false });
        target();
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-zero',
          kind: null,
          amount: '0.00',
        });
        billing.voidSupersededOpenInvoices.mockResolvedValueOnce(1);
        const res = await service.changePlan(TENANT, { planId: 'p2' } as any);
        expect(res.mode).toBe('checkout');
      });

      it('an open RENEWAL invoice is still owed — auto-renew off does not cancel it, the change stays blocked', async () => {
        nonRenewing();
        target();
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-renewal',
          kind: SubscriptionInvoiceKind.RENEWAL,
        });
        await expect(
          service.changePlan(TENANT, { planId: 'p2' } as any),
        ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
        expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
        expect(billing.generateInvoice).not.toHaveBeenCalled();
      });

      it('a hosted checkout Tap confirms CAPTURED for another plan is booked, then the change is decided again from the new state', async () => {
        const sub = nonRenewing();
        target();
        const open = {
          id: 'inv-old',
          kind: SubscriptionInvoiceKind.UPGRADE,
          target_plan_id: 'p9',
          checkout_charge_id: 'chg_paid',
        };
        // Before the settle the open invoice is there; after it, it is PAID (gone).
        billing.findOpenInvoice
          .mockResolvedValueOnce(open)
          .mockResolvedValue(null);
        billing.reconcileHostedCheckout.mockImplementationOnce(async () => {
          // What the ONE settle path does for a paid UPGRADE.
          sub.plan = plan({ id: 'p9', price: 150 });
          return 'paid';
        });
        billing.generateInvoice.mockResolvedValueOnce({ id: 'inv-up' });

        const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

        expect(billing.reconcileHostedCheckout).toHaveBeenCalledWith(open);
        // The captured invoice is never voided under the payer.
        expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
        expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
        // p9 (150) -> p2 (200) is still an upgrade: a fresh quote.
        expect(res).toMatchObject({ mode: 'checkout', invoiceId: 'inv-up' });
      });

      it('a hosted checkout Tap confirms CAPTURED for the requested plan means the change already happened', async () => {
        const sub = nonRenewing();
        target();
        billing.findOpenInvoice
          .mockResolvedValueOnce({
            id: 'inv-old',
            kind: SubscriptionInvoiceKind.UPGRADE,
            target_plan_id: 'p9',
            checkout_charge_id: 'chg_paid',
          })
          .mockResolvedValue(null);
        billing.reconcileHostedCheckout.mockImplementationOnce(async () => {
          sub.plan = plan({ id: 'p2', price: 200 });
          return 'paid';
        });

        const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

        expect(res.mode).toBe('switched');
        expect(billing.generateInvoice).not.toHaveBeenCalled();
      });

      it('a captured RENEWAL is booked too — then nothing is owed and the upgrade is quoted', async () => {
        nonRenewing();
        target();
        billing.findOpenInvoice
          .mockResolvedValueOnce({
            id: 'inv-renewal',
            kind: SubscriptionInvoiceKind.RENEWAL,
            checkout_charge_id: 'chg_paid',
          })
          .mockResolvedValue(null);
        billing.reconcileHostedCheckout.mockResolvedValueOnce('paid');
        const res = await service.changePlan(TENANT, { planId: 'p2' } as any);
        expect(res.mode).toBe('checkout');
        expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
      });

      it('a hosted checkout Tap reports FAILED no longer counts as in flight — the quote is replaced', async () => {
        nonRenewing();
        target();
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-old',
          kind: SubscriptionInvoiceKind.UPGRADE,
          target_plan_id: 'p9',
          checkout_charge_id: 'chg_failed',
          checkout_started_at: new Date(),
        });
        billing.reconcileHostedCheckout.mockImplementationOnce(
          async (inv: { checkout_started_at: Date | null }) => {
            inv.checkout_started_at = null;
            return 'cleared';
          },
        );
        billing.isPaymentInFlight.mockImplementation(
          (inv: { checkout_started_at: Date | null }) =>
            !!inv.checkout_started_at,
        );
        billing.voidSupersededOpenInvoices.mockResolvedValueOnce(1);

        const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

        expect(res.mode).toBe('checkout');
        expect(billing.voidSupersededOpenInvoices).toHaveBeenCalled();
      });

      it('a hosted checkout Tap still shows as PENDING (or cannot be asked) blocks the change — nothing is voided', async () => {
        nonRenewing();
        target();
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-old',
          kind: SubscriptionInvoiceKind.UPGRADE,
          target_plan_id: 'p9',
          checkout_charge_id: 'chg_pending',
        });
        billing.reconcileHostedCheckout.mockResolvedValueOnce('pending');

        await expect(
          service.changePlan(TENANT, { planId: 'p2' } as any),
        ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
        expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
        expect(billing.generateInvoice).not.toHaveBeenCalled();
      });

      it('a payment that starts between the check and the void wins: the guarded void affects nothing and the change is refused', async () => {
        nonRenewing();
        target();
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-legacy',
          kind: null,
        });
        billing.voidSupersededOpenInvoices.mockResolvedValueOnce(0);
        await expect(
          service.changePlan(TENANT, { planId: 'p2' } as any),
        ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
        expect(billing.generateInvoice).not.toHaveBeenCalled();
      });

      it('a DOWNGRADE needs no settlement either way: it is scheduled, the open invoice is untouched', async () => {
        const sub = nonRenewing();
        plans.findOne.mockResolvedValueOnce(plan({ id: 'p0', price: 40 }));
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-legacy',
          kind: null,
        });
        const res = await service.changePlan(TENANT, { planId: 'p0' } as any);
        expect(res.mode).toBe('scheduled');
        expect(sub.pending_plan).toEqual({ id: 'p0' });
        expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
        expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
      });
    });

    it('DOWNGRADE: scheduled for the next renewal — no invoice, the plan is unchanged now', async () => {
      const sub = liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      plans.findOne.mockResolvedValueOnce(plan({ id: 'p0', price: 40 }));

      const res = await service.changePlan(TENANT, { planId: 'p0' } as any);

      expect(res.mode).toBe('scheduled');
      expect(res.effectiveAt).toBe(sub.ends_at);
      expect(sub.pending_plan).toEqual({ id: 'p0' });
      expect(sub.plan.id).toBe('p1');
      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(subscriptions.save).not.toHaveBeenCalled();
      // Only pending_plan, and only while the plan/status read are still current.
      expect(
        Object.keys((lastUpdate!.set as jest.Mock).mock.calls[0][0]),
      ).toEqual(['pending_plan']);
      expect(lastUpdate!.andWhere).toHaveBeenCalledWith(
        '"planId" = :expectedPlanId',
        { expectedPlanId: 'p1' },
      );
      expect(lastUpdate!.andWhere).toHaveBeenCalledWith(
        'status = :expectedStatus',
        { expectedStatus: SubscriptionStatus.ACTIVE },
      );
    });

    it('a same-price plan is also scheduled, not charged', async () => {
      liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      plans.findOne.mockResolvedValueOnce(plan({ id: 'p5', price: 100 }));
      const res = await service.changePlan(TENANT, { planId: 'p5' } as any);
      expect(res.mode).toBe('scheduled');
      expect(billing.generateInvoice).not.toHaveBeenCalled();
    });

    it('re-selecting the CURRENT plan withdraws a scheduled downgrade (instead of the old 409)', async () => {
      const sub = liveSub({
        plan: plan({ id: 'p1' }),
        pending_plan: plan({ id: 'p0', price: 40 }),
      });
      const res = await service.changePlan(TENANT, { planId: 'p1' } as any);
      expect(res.mode).toBe('cleared');
      expect(sub.pending_plan).toBeNull();
      expect(subscriptions.save).not.toHaveBeenCalled();
      expect(lastUpdate!.andWhere).toHaveBeenCalledWith(
        'pending_plan_id = :expectedPendingId',
        { expectedPendingId: 'p0' },
      );
    });

    it('re-selecting the current plan with nothing scheduled is still a 409', async () => {
      liveSub({ plan: plan({ id: 'p1' }) });
      await expect(
        service.changePlan(TENANT, { planId: 'p1' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('a SUSPENDED subscription cannot change plan (nothing could apply the payment)', async () => {
      liveSub({ status: SubscriptionStatus.SUSPENDED });
      target();
      await expect(
        service.changePlan(TENANT, { planId: 'p2' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(billing.generateInvoice).not.toHaveBeenCalled();
    });

    it('a FREE target plan switches at once — nothing to charge', async () => {
      const sub = liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      plans.findOne.mockResolvedValueOnce(plan({ id: 'pf', price: 0 }));

      const res = await service.changePlan(TENANT, { planId: 'pf' } as any);

      expect(res.mode).toBe('switched');
      expect(sub.plan).toEqual({ id: 'pf' });
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(billing.voidOpenInvoices).toHaveBeenCalled();
      expect(emitted(SubscriptionPlanChangedEvent)).toHaveLength(1);
    });

    describe('PENDING_PAYMENT — another plan simply re-quotes the unpaid first invoice', () => {
      it('voids the unpaid quote, switches the plan, and issues a new INITIAL invoice', async () => {
        const sub = liveSub({
          status: SubscriptionStatus.PENDING_PAYMENT,
          plan: plan({ id: 'p1', price: 100 }),
        });
        target();
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-old',
          kind: SubscriptionInvoiceKind.INITIAL,
        });
        billing.generateInvoice.mockResolvedValueOnce({ id: 'inv-q2' });

        const res = await service.changePlan(TENANT, { planId: 'p2' } as any);

        expect(billing.voidOpenInvoices).toHaveBeenCalled();
        expect(sub.plan).toEqual({ id: 'p2' });
        expect(sub.status).toBe(SubscriptionStatus.PENDING_PAYMENT); // still unpaid
        expect(res).toMatchObject({ mode: 'checkout', invoiceId: 'inv-q2' });
        expect(billing.generateInvoice).toHaveBeenCalledWith(
          TENANT,
          'sub1',
          200,
          expect.any(Date),
          expect.any(Date),
          'SAR',
          InvoiceStatus.OPEN,
          expect.objectContaining({
            kind: SubscriptionInvoiceKind.INITIAL,
            targetPlanId: 'p2',
          }),
        );
      });

      it('keeps a REACTIVATION quote a reactivation', async () => {
        liveSub({ status: SubscriptionStatus.PENDING_PAYMENT });
        target();
        billing.findOpenInvoice.mockResolvedValue({
          id: 'inv-old',
          kind: SubscriptionInvoiceKind.REACTIVATION,
        });
        await service.changePlan(TENANT, { planId: 'p2' } as any);
        expect(billing.generateInvoice).toHaveBeenCalledWith(
          TENANT,
          'sub1',
          200,
          expect.any(Date),
          expect.any(Date),
          'SAR',
          InvoiceStatus.OPEN,
          expect.objectContaining({
            kind: SubscriptionInvoiceKind.REACTIVATION,
          }),
        );
      });

      it('refuses while the unpaid invoice has a checkout open', async () => {
        liveSub({ status: SubscriptionStatus.PENDING_PAYMENT });
        target();
        billing.findOpenInvoice.mockResolvedValue({ id: 'inv-old' });
        billing.isPaymentInFlight.mockReturnValue(true);
        await expect(
          service.changePlan(TENANT, { planId: 'p2' } as any),
        ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
        expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
      });
    });
  });

  // ───────────────────────────── cancel / reactivate ────────────────────── //

  describe('cancel', () => {
    it('a second cancel-at-period-end is a no-op: nothing written, no second event', async () => {
      liveSub({ auto_renew: false });
      await service.cancel(TENANT, { cancelAtPeriodEnd: true } as any);
      expect(subscriptions.createQueryBuilder).not.toHaveBeenCalled();
      expect(subscriptions.save).not.toHaveBeenCalled();
      expect(emitted(SubscriptionCancelledEvent)).toHaveLength(0);
    });

    it('cancel-at-period-end writes ONLY auto_renew (a settlement committing meanwhile is not undone)', async () => {
      liveSub();
      await service.cancel(TENANT, { cancelAtPeriodEnd: true } as any);
      expect((lastUpdate!.set as jest.Mock).mock.calls[0][0]).toEqual({
        auto_renew: false,
      });
      expect(subscriptions.save).not.toHaveBeenCalled();
    });

    it('an immediate cancel is refused (409) when the status moved on meanwhile — e.g. the first payment just activated it', async () => {
      liveSub({ status: SubscriptionStatus.PENDING_PAYMENT });
      const qb = createMockQueryBuilder();
      (qb.execute as jest.Mock).mockResolvedValue({ affected: 0, raw: [] });
      subscriptions.createQueryBuilder.mockReturnValue(qb);
      await expect(
        service.cancel(TENANT, { cancelAtPeriodEnd: false } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(qb.andWhere).toHaveBeenCalledWith('status = :expectedStatus', {
        expectedStatus: SubscriptionStatus.PENDING_PAYMENT,
      });
      expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
      expect(emitted(SubscriptionCancelledEvent)).toHaveLength(0);
    });

    it('a downgrade decided from a plan that changed meanwhile (a paid upgrade) is refused (409), not written', async () => {
      billing.supportsCheckout = true;
      liveSub({ plan: plan({ id: 'p1', price: 100 }) });
      plans.findOne.mockResolvedValueOnce(plan({ id: 'p0', price: 40 }));
      const qb = createMockQueryBuilder();
      (qb.execute as jest.Mock).mockResolvedValue({ affected: 0, raw: [] });
      subscriptions.createQueryBuilder.mockReturnValue(qb);
      await expect(
        service.changePlan(TENANT, { planId: 'p0' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('cancels immediately when not at period end, and drops any scheduled downgrade', async () => {
      const sub = liveSub({ pending_plan: plan({ id: 'p0' }) });
      await service.cancel(TENANT, { cancelAtPeriodEnd: false } as any);
      expect(sub.status).toBe(SubscriptionStatus.CANCELLED);
      expect(sub.auto_renew).toBe(false);
      expect(sub.pending_plan).toBeNull();
      expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
      // …but its idle unpaid invoices (an open renewal, say) are voided — never one
      // somebody is paying right now (the 'all' scope still applies the in-flight rule).
      expect(billing.voidSupersededOpenInvoices).toHaveBeenCalledWith(
        'sub1',
        expect.stringContaining('cancelled'),
        'all',
      );
      expect(emitted(SubscriptionCancelledEvent)[0][1]).toMatchObject({
        cancelAtPeriodEnd: false,
      });
    });

    it('cancel-at-period-end keeps the status and access until ends_at', async () => {
      const sub = liveSub();
      await service.cancel(TENANT, { cancelAtPeriodEnd: true } as any);
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.auto_renew).toBe(false);
      // The subscription keeps running to ends_at: nothing to void yet. Turning
      // auto-renew off is NOT cancelling an invoice — whatever is open stays open.
      expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
      expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
    });

    it('cancel-at-period-end KEEPS a scheduled downgrade — it still takes effect at ends_at', async () => {
      const sub = liveSub({ pending_plan: plan({ id: 'p0', price: 40 }) });
      await service.cancel(TENANT, { cancelAtPeriodEnd: true } as any);
      expect(sub.auto_renew).toBe(false);
      expect(sub.pending_plan).toMatchObject({ id: 'p0' });
    });

    it('a PENDING_PAYMENT subscription is cancelled at once even at period end — and its unpaid invoice is voided', async () => {
      const sub = liveSub({ status: SubscriptionStatus.PENDING_PAYMENT });
      await service.cancel(TENANT, { cancelAtPeriodEnd: true } as any);
      expect(sub.status).toBe(SubscriptionStatus.CANCELLED);
      expect(billing.voidOpenInvoices).toHaveBeenCalledWith(
        'sub1',
        expect.stringContaining('before payment'),
      );
      expect(access.invalidate).toHaveBeenCalledWith(TENANT);
      expect(emitted(SubscriptionCancelledEvent)[0][1]).toMatchObject({
        cancelAtPeriodEnd: false,
      });
    });
  });

  describe('reactivate — ACTIVE with auto-renew OFF (resume auto-renew)', () => {
    const wireUpdate = (affected: number) => {
      const qb = createMockQueryBuilder();
      (qb.execute as jest.Mock).mockResolvedValue({ affected, raw: [] });
      subscriptions.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    it.each([
      ['legacy (no checkout)', false],
      ['Tap (checkout bound)', true],
    ])(
      '%s: turns auto-renew back on with NO charge and NO invoice — the period is already paid',
      async (_l, checkout) => {
        billing.supportsCheckout = checkout;
        const sub = liveSub({
          auto_renew: false,
          pending_plan: plan({ id: 'p0', price: 40 }),
        });
        const qb = wireUpdate(1);

        const res = await service.reactivate(TENANT);

        expect(qb.set).toHaveBeenCalledWith({ auto_renew: true });
        // Guarded on the state that was read: only an ACTIVE, non-renewing row flips.
        expect(qb.where).toHaveBeenCalledWith(
          'id = :id AND auto_renew = false AND status = :active',
          { id: 'sub1', active: SubscriptionStatus.ACTIVE },
        );
        expect(res.subscription.auto_renew).toBe(true);
        expect(res.subscription.status).toBe(SubscriptionStatus.ACTIVE);
        // Paid-through date and a scheduled downgrade are untouched.
        expect(sub.ends_at).toBe(future);
        expect(sub.pending_plan).toMatchObject({ id: 'p0' });
        expect(billing.generateInvoice).not.toHaveBeenCalled();
        expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
        expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
        expect(subscriptions.save).not.toHaveBeenCalled();
        expect(access.invalidate).toHaveBeenCalledWith(TENANT);
        expect(emitted(SubscriptionReactivatedEvent)).toHaveLength(1);
      },
    );

    it('a concurrent second request (the row already flipped) gets the old 409 and emits nothing', async () => {
      billing.supportsCheckout = true;
      liveSub({ auto_renew: false });
      wireUpdate(0);
      await expect(service.reactivate(TENANT)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(emitted(SubscriptionReactivatedEvent)).toHaveLength(0);
      expect(billing.generateInvoice).not.toHaveBeenCalled();
    });

    it('an ACTIVE subscription that IS renewing is still a 409 (nothing to reactivate)', async () => {
      billing.supportsCheckout = true;
      liveSub({ auto_renew: true });
      await expect(service.reactivate(TENANT)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(subscriptions.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('reactivate — no provider can check out (legacy)', () => {
    it('rejects an already-active subscription', async () => {
      liveSub({ status: SubscriptionStatus.ACTIVE });
      await expect(service.reactivate(TENANT)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('renews an expired subscription window straight back to ACTIVE', async () => {
      const sub = liveSub({
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
      });
      const res = await service.reactivate(TENANT);
      expect(res.subscription.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.ends_at.getTime()).toBeGreaterThan(Date.now());
      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(emitted(SubscriptionReactivatedEvent)).toHaveLength(1);
    });

    it('a FREE plan reactivates immediately even where a provider could check out', async () => {
      billing.supportsCheckout = true;
      liveSub({
        status: SubscriptionStatus.CANCELLED,
        ends_at: past,
        plan: plan({ price: 0 }),
      });
      const res = await service.reactivate(TENANT);
      expect(res.subscription.status).toBe(SubscriptionStatus.ACTIVE);
      expect(billing.generateInvoice).not.toHaveBeenCalled();
    });
  });

  describe('reactivate — D2 (a provider that can check out is bound)', () => {
    beforeEach(() => {
      billing.supportsCheckout = true;
    });

    it('PENDING_PAYMENT: nothing new is issued — the same open invoice is handed back', async () => {
      liveSub({ status: SubscriptionStatus.PENDING_PAYMENT });
      billing.findOpenInvoice.mockResolvedValue({
        id: 'inv-pending',
        kind: 'INITIAL',
        amount: '100.00',
        currency: 'SAR',
      });
      const res = await service.reactivate(TENANT);
      expect(res.openInvoice).toMatchObject({ id: 'inv-pending' });
      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(subscriptions.save).not.toHaveBeenCalled();
    });

    it('CANCELLED but the paid period is still running: resumes at once, no charge', async () => {
      const sub = liveSub({
        status: SubscriptionStatus.CANCELLED,
        ends_at: future,
        auto_renew: false,
      });
      const res = await service.reactivate(TENANT);
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.auto_renew).toBe(true);
      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(res.isUsable).toBe(true);
      expect(emitted(SubscriptionReactivatedEvent)).toHaveLength(1);
    });

    it('CANCELLED and lapsed: a REACTIVATION invoice is issued and the subscription waits as PENDING_PAYMENT (not usable)', async () => {
      const sub = liveSub({
        status: SubscriptionStatus.CANCELLED,
        ends_at: past,
        auto_renew: false,
      });
      const res = await service.reactivate(TENANT);

      expect(billing.generateInvoice).toHaveBeenCalledWith(
        TENANT,
        'sub1',
        100,
        expect.any(Date),
        expect.any(Date),
        'SAR',
        InvoiceStatus.OPEN,
        {
          kind: SubscriptionInvoiceKind.REACTIVATION,
          targetPlanId: 'p1',
          provider: 'tap',
        },
      );
      expect(sub.status).toBe(SubscriptionStatus.PENDING_PAYMENT);
      expect(sub.auto_renew).toBe(true);
      expect(sub.ends_at.getTime()).toBeGreaterThan(Date.now());
      expect(res.isUsable).toBe(false);
      // Not reactivated yet — the settle path announces it when the invoice is paid.
      expect(emitted(SubscriptionReactivatedEvent)).toHaveLength(0);
    });

    it('PAST_DUE with its renewal invoice already open: pay THAT one — no second invoice, status untouched', async () => {
      const sub = liveSub({
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        auto_renew: false,
      });
      billing.findOpenInvoice.mockResolvedValue({
        id: 'inv-renewal',
        kind: SubscriptionInvoiceKind.RENEWAL,
        amount: '100.00',
        currency: 'SAR',
      });
      const res = await service.reactivate(TENANT);
      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(sub.status).toBe(SubscriptionStatus.PAST_DUE); // grace rules still apply
      expect(sub.auto_renew).toBe(true); // the retry job resumes
      expect(res.openInvoice).toMatchObject({ id: 'inv-renewal' });
    });

    it('GRACE_EXPIRED with nothing open: a REACTIVATION invoice is issued and the status is NOT downgraded to PENDING_PAYMENT', async () => {
      const sub = liveSub({
        status: SubscriptionStatus.GRACE_EXPIRED,
        ends_at: past,
      });
      await service.reactivate(TENANT);
      expect(billing.generateInvoice).toHaveBeenCalledWith(
        TENANT,
        'sub1',
        100,
        expect.any(Date),
        expect.any(Date),
        'SAR',
        InvoiceStatus.OPEN,
        expect.objectContaining({ kind: SubscriptionInvoiceKind.REACTIVATION }),
      );
      expect(sub.status).toBe(SubscriptionStatus.GRACE_EXPIRED);
    });

    it('a lapsed CANCELLED one with an idle stale invoice voids it before issuing its own', async () => {
      liveSub({ status: SubscriptionStatus.CANCELLED, ends_at: past });
      billing.findOpenInvoice.mockResolvedValue({
        id: 'inv-stale',
        kind: null,
      });
      await service.reactivate(TENANT);
      expect(billing.voidOpenInvoices).toHaveBeenCalledWith(
        'sub1',
        expect.stringContaining('reactivation'),
      );
      expect(billing.generateInvoice).toHaveBeenCalledTimes(1);
    });

    it('refuses while an invoice of that subscription is being paid right now', async () => {
      liveSub({ status: SubscriptionStatus.CANCELLED, ends_at: past });
      billing.findOpenInvoice.mockResolvedValue({ id: 'inv-live', kind: null });
      billing.isPaymentInFlight.mockReturnValue(true);
      await expect(service.reactivate(TENANT)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(billing.voidOpenInvoices).not.toHaveBeenCalled();
    });

    it.each([SubscriptionStatus.SUSPENDED, SubscriptionStatus.TRIAL])(
      'a %s subscription is not reactivated by the clinic',
      async (status) => {
        liveSub({ status });
        await expect(service.reactivate(TENANT)).rejects.toMatchObject({
          code: ErrorCode.CONFLICT,
        });
        expect(billing.generateInvoice).not.toHaveBeenCalled();
      },
    );
  });

  // ──────────────────────── effective status / access ───────────────────── //

  describe('getEffectiveStatus / getCurrent', () => {
    // FND-031: the OLD 'EXPIRED' derivation made an active-past-end-date
    // subscription silently unusable forever — no grace, no notice, no path
    // back (the exact "silent lapse" this finding fixes). It now LIVE-derives
    // into PAST_DUE (== expired-in-grace, full capabilities preserved),
    // matching the real "ACTIVE --ends_at reached--> PAST_DUE" transition
    // instead of a separate limbo state.
    it('derives PAST_DUE (not the old EXPIRED limbo) for an active subscription past its end date', () => {
      expect(
        service.getEffectiveStatus({
          status: SubscriptionStatus.ACTIVE,
          ends_at: past,
        } as any),
      ).toBe(SubscriptionStatus.PAST_DUE);
    });

    it('derives GRACE_EXPIRED for a PAST_DUE subscription whose grace window has elapsed', () => {
      const longAgo = new Date(Date.now() - 30 * 86_400_000);
      expect(
        service.getEffectiveStatus(
          {
            status: SubscriptionStatus.PAST_DUE,
            ends_at: past,
            grace_started_at: longAgo,
          } as any,
          /* graceDurationDays */ 7,
        ),
      ).toBe(SubscriptionStatus.GRACE_EXPIRED);
    });

    it('stays PAST_DUE while still within the grace window', () => {
      const justNow = new Date(Date.now() - 60_000);
      expect(
        service.getEffectiveStatus(
          {
            status: SubscriptionStatus.PAST_DUE,
            ends_at: past,
            grace_started_at: justNow,
          } as any,
          7,
        ),
      ).toBe(SubscriptionStatus.PAST_DUE);
    });

    it('PENDING_PAYMENT passes through unchanged — its provisional dates are NEVER live-derived into PAST_DUE', () => {
      expect(
        service.getEffectiveStatus({
          status: SubscriptionStatus.PENDING_PAYMENT,
          ends_at: past,
        } as any),
      ).toBe(SubscriptionStatus.PENDING_PAYMENT);
    });

    /** Wires `subscriptions.createQueryBuilder()` to return `getOne()`
     *  resolving to `row` for exactly the next call — getCurrent's real
     *  mechanism (T046), replacing the old `findOne` mock. */
    function mockCurrentOnce(row: unknown) {
      const qb = createMockQueryBuilder();
      qb.getOne = jest.fn().mockResolvedValue(row);
      subscriptions.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    }

    it('getCurrent throws when there is no subscription', async () => {
      mockCurrentOnce(null);
      await expect(service.getCurrent(TENANT)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    // T046 — the mandatory per-site assertion set (identical result, empty
    // for a foreign tenant, soft-delete exclusion left to TypeORM rather
    // than hand-written, statement count).
    it('getCurrent resolves the subscription identically to before (a matching row)', async () => {
      mockCurrentOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
      });
      const result = await service.getCurrent(TENANT);
      expect(result.subscription.id).toBe('sub-1');
    });

    it('getCurrent also loads the scheduled downgrade, and reports it with the open invoice', async () => {
      const qb = mockCurrentOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
        pending_plan: { id: 'p0' },
      });
      billing.findOpenInvoice.mockResolvedValueOnce({
        id: 'inv-9',
        kind: 'RENEWAL',
        amount: '40.00',
        currency: 'SAR',
      });

      const result = await service.getCurrent(TENANT);

      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith(
        's.pending_plan',
        'pending_plan',
      );
      expect(result.pendingPlan).toEqual({ id: 'p0' });
      expect(result.openInvoice).toEqual({
        id: 'inv-9',
        kind: 'RENEWAL',
        amount: '40.00',
        currency: 'SAR',
      });
    });

    it('getCurrent reports null (not undefined) when nothing is scheduled or open', async () => {
      mockCurrentOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
      });
      const result = await service.getCurrent(TENANT);
      expect(result.pendingPlan).toBeNull();
      expect(result.openInvoice).toBeNull();
    });

    it('getCurrent scopes strictly by the FK column resolved from metadata — a foreign tenant id never widens the filter', async () => {
      const qb = mockCurrentOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
      });
      await service.getCurrent('other-tenant');
      expect(qb.where).toHaveBeenCalledWith('s."tenantId" = :tenantId', {
        tenantId: 'other-tenant',
      });
    });

    it('getCurrent never hand-writes a deleted_at predicate — soft-delete exclusion is TypeORM auto-injection, not a copy that could drift', async () => {
      const qb = mockCurrentOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
      });
      await service.getCurrent(TENANT);
      const allCalls = [...qb.where.mock.calls, ...qb.andWhere.mock.calls];
      expect(allCalls.some(([sql]) => /deleted_at/i.test(String(sql)))).toBe(
        false,
      );
    });

    it('getCurrent reads the subscription with exactly one query (createQueryBuilder, not findOne) with limit(1), never take/skip', async () => {
      const qb = mockCurrentOnce({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
      });
      await service.getCurrent(TENANT);

      expect(subscriptions.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(subscriptions.findOne).not.toHaveBeenCalled();
      expect(qb.getOne).toHaveBeenCalledTimes(1);
      expect(qb.limit).toHaveBeenCalledWith(1);
      expect(qb.take).not.toHaveBeenCalled();
      expect(qb.skip).not.toHaveBeenCalled();
    });

    // The `assertUsable` pass-through this used to cover is gone: it had no
    // callers, and being tenant-WIDE it could never carry the capability a
    // route was gating, so adopting it would have re-created the split where a
    // request is admitted by the guard and refused deeper in. Access is now
    // asserted through AccessControlService with a FeatureKey in hand.

    // FR-B007d: read access (isUsable) is preserved in EVERY non-terminal
    // state, including grace-expired — only CANCELLED/SUSPENDED, and a
    // subscription not paid for yet (PENDING_PAYMENT), are not usable.
    it.each([
      [SubscriptionStatus.ACTIVE, true],
      [SubscriptionStatus.TRIAL, true],
      [SubscriptionStatus.PAST_DUE, true],
      [SubscriptionStatus.GRACE_EXPIRED, true],
      [SubscriptionStatus.CANCELLED, false],
      [SubscriptionStatus.SUSPENDED, false],
      [SubscriptionStatus.PENDING_PAYMENT, false],
    ])(
      'isUsable(%s) === %s (read access preserved through grace)',
      (status, expected) => {
        expect(service.isUsable({ status, ends_at: future } as any)).toBe(
          expected,
        );
      },
    );

    it.each([
      [SubscriptionStatus.PENDING_PAYMENT, 'pending-payment'],
      [SubscriptionStatus.CANCELLED, 'terminal'],
      [SubscriptionStatus.GRACE_EXPIRED, 'grace-expired'],
      [SubscriptionStatus.ACTIVE, 'active'],
    ])('the access state of %s is "%s"', async (status, accessState) => {
      mockCurrentOnce({ id: 'sub-1', status, ends_at: future });
      expect((await service.getCurrent(TENANT)).accessState).toBe(accessState);
    });
  });

  describe('assertBillableActionAllowed (FND-031/T082)', () => {
    it('refuses a billable/usage-increasing action once grace-expired', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub1',
        status: SubscriptionStatus.GRACE_EXPIRED,
        ends_at: past,
        plan: plan(),
      });
      await expect(
        service.assertBillableActionAllowed(TENANT),
      ).rejects.toMatchObject({
        code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED,
      });
    });

    it('allows a billable action during expired-in-grace (PAST_DUE) — full capabilities unchanged', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub1',
        status: SubscriptionStatus.PAST_DUE,
        ends_at: past,
        grace_started_at: new Date(),
        plan: plan(),
      });
      await expect(
        service.assertBillableActionAllowed(TENANT),
      ).resolves.toBeUndefined();
    });

    it('allows a billable action for an active subscription', async () => {
      subscriptions.findOne.mockResolvedValueOnce({
        id: 'sub1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: future,
        plan: plan(),
      });
      await expect(
        service.assertBillableActionAllowed(TENANT),
      ).resolves.toBeUndefined();
    });
  });
});
