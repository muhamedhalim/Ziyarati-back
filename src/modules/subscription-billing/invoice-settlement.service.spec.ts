import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';

import {
  InvoiceSettlementService,
  type SettleEvidence,
} from './invoice-settlement.service';
import { PaymentMethodService } from './payment-method.service';
import { AccessControlService } from './access-control.service';
import { computeNextPeriodEnd } from './subscription-period.util';
import { EmailService } from '../email/email.service';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import {
  BillingCycle,
  InvoiceStatus,
  SubscriptionInvoiceKind,
  SubscriptionStatus,
} from '../../entities/enums';
import {
  SubscriptionActivatedEvent,
  SubscriptionPlanChangedEvent,
  SubscriptionReactivatedEvent,
} from '../../events/subscription.events';
import {
  createMockDataSource,
  createMockEntityManager,
  createMockRepository,
  MockDataSource,
  MockEntityManager,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const PLAN_A = {
  id: 'plan-a',
  name: 'Basic',
  price: '100.00',
  billing_cycle: BillingCycle.MONTHLY,
};
const PLAN_B = {
  id: 'plan-b',
  name: 'Pro',
  price: '300.00',
  billing_cycle: BillingCycle.MONTHLY,
};
const PLAN_YEARLY = {
  id: 'plan-y',
  name: 'Yearly',
  price: '900.00',
  billing_cycle: BillingCycle.YEARLY,
};

const evidence = (over: Partial<SettleEvidence> = {}): SettleEvidence => ({
  source: 'webhook',
  provider: 'tap',
  reference: 'chg_1',
  webhookEventId: 'tap:chg_1:CAPTURED',
  capturedMinorUnits: 10000,
  capturedCurrency: 'SAR',
  ...over,
});

describe('InvoiceSettlementService', () => {
  let service: InvoiceSettlementService;
  let invoiceRepo: MockRepository;
  let subRepo: MockRepository;
  let planRepo: MockRepository;
  let tenants: MockRepository;
  let plans: MockRepository;
  let manager: MockEntityManager;
  let dataSource: MockDataSource;
  let methods: { upsertDefault: jest.Mock };
  let access: { invalidate: jest.Mock };
  let emitter: { emit: jest.Mock };
  let audit: { record: jest.Mock };
  let email: { sendInvoice: jest.Mock };

  const invoice = (over: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    tenant_id: TENANT,
    subscription_id: 'sub-1',
    amount: '100.00',
    currency: 'SAR',
    status: InvoiceStatus.OPEN,
    kind: SubscriptionInvoiceKind.INITIAL as string | null,
    target_plan_id: 'plan-a' as string | null,
    period_start: new Date('2026-10-01T00:00:00.000Z'),
    period_end: new Date('2026-11-01T00:00:00.000Z'),
    webhook_event_id: null as string | null,
    provider_reference: null as string | null,
    payment_method_id: null as string | null,
    charge_started_at: new Date() as Date | null,
    checkout_started_at: new Date() as Date | null,
    next_retry_at: null as Date | null,
    failure_reason: 'earlier decline' as string | null,
    failure_class: 'X' as string | null,
    paid_at: undefined as Date | undefined,
    ...over,
  });

  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    status: SubscriptionStatus.PENDING_PAYMENT,
    plan: PLAN_A,
    pending_plan: null as unknown,
    auto_renew: true,
    starts_at: new Date('2026-09-01T00:00:00.000Z'),
    ends_at: new Date('2026-10-01T00:00:00.000Z'),
    grace_started_at: new Date('2026-10-02T00:00:00.000Z') as Date | null,
    grace_expired_at: null as Date | null,
    ...over,
  });

  /** Programs the invoice + subscription the transaction will see. */
  const arrange = (
    inv: ReturnType<typeof invoice> | null,
    sub: ReturnType<typeof subscription> | null = null,
  ) => {
    invoiceRepo.findOne.mockResolvedValue(inv);
    // The locked read and the later read WITH relations are the same live object,
    // so the service's mutations are observable on `sub`.
    subRepo.findOne.mockImplementation(async () => sub);
    return { inv, sub };
  };

  beforeEach(async () => {
    invoiceRepo = createMockRepository();
    subRepo = createMockRepository();
    planRepo = createMockRepository();
    tenants = createMockRepository();
    plans = createMockRepository();
    manager = createMockEntityManager(
      new Map<unknown, MockRepository>([
        [SubscriptionInvoice, invoiceRepo],
        [Subscription, subRepo],
        [SubscriptionPlan, planRepo],
      ]),
    );
    dataSource = createMockDataSource(manager);
    methods = {
      upsertDefault: jest.fn().mockResolvedValue({ id: 'pm-1' }),
    };
    access = { invalidate: jest.fn() };
    emitter = { emit: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    email = { sendInvoice: jest.fn() };
    tenants.findOne.mockResolvedValue({
      id: TENANT,
      contact_email: 'owner@clinic.test',
    });
    plans.findOne.mockResolvedValue(PLAN_A);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceSettlementService,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: getRepositoryToken(SubscriptionPlan), useValue: plans },
        { provide: DataSource, useValue: dataSource },
        { provide: PaymentMethodService, useValue: methods },
        { provide: AccessControlService, useValue: access },
        { provide: EventEmitter2, useValue: emitter },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: EmailService, useValue: email },
      ],
    }).compile();
    service = moduleRef.get(InvoiceSettlementService);
  });

  afterEach(() => jest.clearAllMocks());

  const emitted = (EventClass: { eventName: string }) =>
    emitter.emit.mock.calls.filter(([name]) => name === EventClass.eventName);

  // ───────────────────────────── guards ───────────────────────────── //

  describe('locking', () => {
    it('locks the INVOICE and the SUBSCRIPTION rows alone — never a relation under FOR UPDATE (Postgres rejects the outer join)', async () => {
      const { inv, sub } = arrange(invoice(), subscription());
      await service.settleInvoicePaid(inv!.id, evidence());

      const lockedReads = (repo: MockRepository) =>
        repo.findOne.mock.calls.map(([o]) => o).filter((o: any) => o?.lock);
      for (const repo of [invoiceRepo, subRepo]) {
        const locked = lockedReads(repo);
        expect(locked.length).toBeGreaterThan(0);
        for (const o of locked) {
          expect(o.lock).toEqual({ mode: 'pessimistic_write' });
          expect(o.relations).toBeUndefined();
        }
      }
      // relations are read separately, unlocked
      const relationReads = subRepo.findOne.mock.calls
        .map(([o]) => o)
        .filter((o: any) => o?.relations);
      expect(relationReads).toHaveLength(1);
      expect(relationReads[0].lock).toBeUndefined();
      expect(relationReads[0].relations).toEqual({
        plan: true,
        pending_plan: true,
      });
      expect(sub).toBeDefined();
    });

    it('runs in ONE transaction', async () => {
      arrange(invoice(), subscription());
      await service.settleInvoicePaid('inv-1', evidence());
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('what is NOT booked', () => {
    it('an unknown invoice is rejected', async () => {
      arrange(null);
      const res = await service.settleInvoicePaid('nope', evidence());
      expect(res).toEqual({
        outcome: 'rejected',
        reason: 'invoice_not_found',
        invoice: null,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('an invoice that is already PAID is returned untouched (idempotent) — no lifecycle, no events, no e-mail', async () => {
      const inv = invoice({
        status: InvoiceStatus.PAID,
        provider_reference: 'chg_1',
      });
      arrange(inv, subscription());
      const res = await service.settleInvoicePaid(
        'inv-1',
        evidence({ webhookEventId: null }),
      );
      expect(res.outcome).toBe('already_paid');
      expect(subRepo.save).not.toHaveBeenCalled();
      expect(invoiceRepo.save).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
      expect(email.sendInvoice).not.toHaveBeenCalled();
      expect(access.invalidate).not.toHaveBeenCalled();
    });

    it('the SAME webhook delivery again is recognised by its dedupe key and does nothing', async () => {
      const inv = invoice({ webhook_event_id: 'tap:chg_1:CAPTURED' });
      arrange(inv, subscription());
      const res = await service.settleInvoicePaid('inv-1', evidence());
      expect(res.outcome).toBe('already_paid');
      expect(inv.status).toBe(InvoiceStatus.OPEN);
      expect(invoiceRepo.save).not.toHaveBeenCalled();
    });

    it('a SECOND capture for an already-paid invoice raises a duplicate-capture ALERT (nothing is auto-refunded)', async () => {
      const inv = invoice({
        status: InvoiceStatus.PAID,
        provider_reference: 'chg_FIRST',
      });
      arrange(inv, subscription());
      const err = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation();
      const res = await service.settleInvoicePaid(
        'inv-1',
        evidence({ reference: 'chg_SECOND' }),
      );
      expect(res.outcome).toBe('already_paid');
      expect(err).toHaveBeenCalledWith(
        expect.stringContaining('ALERT: duplicate capture'),
      );
      expect(err).toHaveBeenCalledWith(expect.stringContaining('chg_SECOND'));
    });

    it('the same capture seen twice (return page + webhook) is NOT a duplicate-capture alert', async () => {
      const inv = invoice({
        status: InvoiceStatus.PAID,
        provider_reference: 'chg_1',
      });
      arrange(inv, subscription());
      const err = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation();
      await service.settleInvoicePaid(
        'inv-1',
        evidence({ webhookEventId: null }),
      );
      expect(err).not.toHaveBeenCalled();
    });

    it('remembers a webhook delivery on an already-paid invoice so a replay short-circuits', async () => {
      const inv = invoice({
        status: InvoiceStatus.PAID,
        provider_reference: 'chg_1',
      });
      arrange(inv, subscription());
      await service.settleInvoicePaid(
        'inv-1',
        evidence({ webhookEventId: 'tap:chg_1:CAPTURED' }),
      );
      expect(inv.webhook_event_id).toBe('tap:chg_1:CAPTURED');
      expect(invoiceRepo.save).toHaveBeenCalledWith(inv);
    });

    it.each([InvoiceStatus.VOID, InvoiceStatus.REFUNDED])(
      'a payment captured for a %s invoice is NOT booked: rejected, ALERT, and no subscription change',
      async (status) => {
        const inv = invoice({ status });
        const { sub } = arrange(inv, subscription());
        const err = jest
          .spyOn((service as any).logger, 'error')
          .mockImplementation();

        const res = await service.settleInvoicePaid('inv-1', evidence());

        expect(res.outcome).toBe('rejected');
        expect(res.reason).toBe(`invoice_${status.toLowerCase()}`);
        expect(err).toHaveBeenCalledWith(expect.stringContaining('ALERT'));
        expect(inv.status).toBe(status); // never resurrected
        expect(subRepo.save).not.toHaveBeenCalled();
        expect(sub!.status).toBe(SubscriptionStatus.PENDING_PAYMENT);
      },
    );

    it('a captured amount that differs from the invoice is NOT booked (anti-tampering) and nothing changes', async () => {
      const inv = invoice();
      arrange(inv, subscription());
      const res = await service.settleInvoicePaid(
        'inv-1',
        evidence({ capturedMinorUnits: 1 }),
      );
      expect(res).toMatchObject({
        outcome: 'rejected',
        reason: 'amount_mismatch',
      });
      expect(inv.status).toBe(InvoiceStatus.OPEN);
      expect(invoiceRepo.save).not.toHaveBeenCalled();
      expect(subRepo.save).not.toHaveBeenCalled();
    });

    it('a captured currency that differs is NOT booked', async () => {
      arrange(invoice(), subscription());
      const res = await service.settleInvoicePaid(
        'inv-1',
        evidence({ capturedCurrency: 'USD' }),
      );
      expect(res.reason).toBe('amount_mismatch');
    });

    it('currency is compared case-insensitively, and an absent figure skips only that check', async () => {
      arrange(invoice(), subscription());
      const res = await service.settleInvoicePaid(
        'inv-1',
        evidence({ capturedCurrency: 'sar', capturedMinorUnits: undefined }),
      );
      expect(res.outcome).toBe('settled');
    });

    describe('amountRequired (a real gateway) fails closed', () => {
      it.each([
        ['no captured amount', { capturedMinorUnits: undefined }],
        ['no captured currency', { capturedCurrency: undefined }],
        [
          'neither',
          { capturedMinorUnits: undefined, capturedCurrency: undefined },
        ],
      ])('%s: NOT booked, with an ALERT', async (_l, over) => {
        const inv = invoice();
        arrange(inv, subscription());
        const err = jest
          .spyOn((service as any).logger, 'error')
          .mockImplementation(() => undefined);

        const res = await service.settleInvoicePaid(
          'inv-1',
          evidence({ amountRequired: true, ...over }),
        );

        expect(res).toMatchObject({
          outcome: 'rejected',
          reason: 'amount_mismatch',
        });
        expect(inv.status).toBe(InvoiceStatus.OPEN);
        expect(invoiceRepo.save).not.toHaveBeenCalled();
        expect(subRepo.save).not.toHaveBeenCalled();
        expect(err).toHaveBeenCalledWith(
          expect.stringMatching(
            /^ALERT: invoice inv-1: tap captured no captured/,
          ),
        );
      });

      it('a complete, matching capture is booked as before', async () => {
        arrange(invoice(), subscription());
        const res = await service.settleInvoicePaid(
          'inv-1',
          evidence({ amountRequired: true }),
        );
        expect(res.outcome).toBe('settled');
      });

      it('a wrong amount is still refused when required', async () => {
        arrange(invoice(), subscription());
        const res = await service.settleInvoicePaid(
          'inv-1',
          evidence({ amountRequired: true, capturedMinorUnits: 1 }),
        );
        expect(res.reason).toBe('amount_mismatch');
      });
    });

    it.each([InvoiceStatus.DRAFT, InvoiceStatus.UNCOLLECTIBLE])(
      'a %s invoice is still payable',
      async (status) => {
        arrange(invoice({ status }), subscription());
        expect(
          (await service.settleInvoicePaid('inv-1', evidence())).outcome,
        ).toBe('settled');
      },
    );
  });

  // ───────────────────────────── the invoice itself ───────────────────────── //

  describe('marking the invoice PAID', () => {
    it('sets the paid facts, clears every in-flight marker, and stores the dedupe key', async () => {
      const inv = invoice();
      arrange(inv, subscription());
      const res = await service.settleInvoicePaid('inv-1', evidence());

      expect(res.outcome).toBe('settled');
      expect(inv).toMatchObject({
        status: InvoiceStatus.PAID,
        provider_reference: 'chg_1',
        provider: 'tap',
        failure_reason: null,
        failure_class: null,
        charge_started_at: null,
        checkout_started_at: null,
        next_retry_at: null,
        webhook_event_id: 'tap:chg_1:CAPTURED',
      });
      expect(inv.paid_at).toBeInstanceOf(Date);
      expect(invoiceRepo.save).toHaveBeenCalledWith(inv);
    });

    it('records the saved card that was CHARGED on a merchant-initiated renewal', async () => {
      const inv = invoice({
        kind: SubscriptionInvoiceKind.RENEWAL,
        period_start: new Date('2026-10-01T00:00:00.000Z'),
      });
      arrange(inv, subscription({ status: SubscriptionStatus.PAST_DUE }));
      await service.settleInvoicePaid(
        'inv-1',
        evidence({
          source: 'charge',
          paymentMethodId: 'pm-7',
          webhookEventId: null,
        }),
      );
      expect(inv.payment_method_id).toBe('pm-7');
    });

    it('a legacy (kind-less) invoice only marks itself PAID — the subscription is never touched', async () => {
      const inv = invoice({ kind: null, target_plan_id: null });
      arrange(inv, subscription({ status: SubscriptionStatus.ACTIVE }));
      const res = await service.settleInvoicePaid('inv-1', evidence());
      expect(res.outcome).toBe('settled');
      expect(subRepo.findOne).not.toHaveBeenCalled();
      expect(subRepo.save).not.toHaveBeenCalled();
      expect(access.invalidate).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
      // still audited + receipted
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_PAYMENT_SETTLED,
        }),
      );
      expect(email.sendInvoice).toHaveBeenCalled();
    });
  });

  // ───────────────────────────── lifecycle by kind ───────────────────────── //

  describe('INITIAL — PENDING_PAYMENT → ACTIVE, the period counted from the payment', () => {
    it('activates, starts the period now, realigns the invoice to it, and announces the activation', async () => {
      const inv = invoice();
      const sub = subscription();
      arrange(inv, sub);
      const before = Date.now();

      const res = await service.settleInvoicePaid('inv-1', evidence());

      expect(res.outcome).toBe('settled');
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.starts_at.getTime()).toBeGreaterThanOrEqual(before);
      expect(sub.ends_at).toEqual(
        computeNextPeriodEnd(sub.starts_at, PLAN_A as never),
      );
      expect(sub.grace_started_at).toBeNull();
      expect(sub.pending_plan).toBeNull();
      // the invoice covers the period the payment actually started
      expect(inv.period_start).toEqual(sub.starts_at);
      expect(inv.period_end).toEqual(sub.ends_at);
      expect(subRepo.save).toHaveBeenCalledWith(sub);
      expect(access.invalidate).toHaveBeenCalledWith(TENANT);
      expect(emitted(SubscriptionActivatedEvent)).toHaveLength(1);
      expect(emitted(SubscriptionActivatedEvent)[0][1]).toMatchObject({
        tenantId: TENANT,
        subscriptionId: 'sub-1',
        planId: 'plan-a',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_PAYMENT_SETTLED,
          entityId: 'inv-1',
        }),
      );
      expect(email.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@clinic.test',
          amount: '100.00',
          planName: 'Basic',
        }),
      );
    });

    it('uses the plan the invoice was issued for, even if the subscription row says otherwise', async () => {
      const inv = invoice({ target_plan_id: 'plan-y' });
      const sub = subscription({ plan: PLAN_A });
      arrange(inv, sub);
      planRepo.findOne.mockResolvedValueOnce(PLAN_YEARLY);

      await service.settleInvoicePaid(
        'inv-1',
        evidence({ capturedMinorUnits: 10000 }),
      );

      expect(sub.plan).toBe(PLAN_YEARLY);
      expect(sub.ends_at).toEqual(
        computeNextPeriodEnd(sub.starts_at, PLAN_YEARLY as never),
      );
    });

    it.each([
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.CANCELLED,
      SubscriptionStatus.SUSPENDED,
      SubscriptionStatus.PAST_DUE,
    ])(
      'a payment for an initial invoice whose subscription is %s is recorded but NOT applied — PAID, ALERT, no silent (re)activation',
      async (status) => {
        const inv = invoice();
        const sub = subscription({ status });
        arrange(inv, sub);
        const err = jest
          .spyOn((service as any).logger, 'error')
          .mockImplementation();

        const res = await service.settleInvoicePaid('inv-1', evidence());

        expect(res.outcome).toBe('settled_unapplied');
        expect(res.reason).toBe(`subscription_${status.toLowerCase()}`);
        expect(inv.status).toBe(InvoiceStatus.PAID); // money moved: recorded
        expect(sub.status).toBe(status); // …but the subscription is untouched
        expect(subRepo.save).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
        expect(err).toHaveBeenCalledWith(expect.stringContaining('ALERT'));
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_PAYMENT_UNAPPLIED,
          }),
        );
        expect(email.sendInvoice).not.toHaveBeenCalled();
      },
    );

    it('a missing subscription or plan is recorded unapplied, never thrown', async () => {
      arrange(invoice(), null);
      expect(
        (await service.settleInvoicePaid('inv-1', evidence())).reason,
      ).toBe('subscription_missing');

      arrange(invoice({ target_plan_id: 'gone' }), subscription());
      planRepo.findOne.mockResolvedValueOnce(null);
      expect(
        (await service.settleInvoicePaid('inv-1', evidence())).reason,
      ).toBe('target_plan_missing');
    });
  });

  describe('REACTIVATION', () => {
    it('brings a PENDING_PAYMENT subscription back ACTIVE with auto-renew on, and announces the reactivation', async () => {
      const inv = invoice({ kind: SubscriptionInvoiceKind.REACTIVATION });
      const sub = subscription({ auto_renew: false });
      arrange(inv, sub);
      await service.settleInvoicePaid('inv-1', evidence());
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.auto_renew).toBe(true);
      expect(emitted(SubscriptionReactivatedEvent)).toHaveLength(1);
      expect(emitted(SubscriptionActivatedEvent)).toHaveLength(0);
    });

    it.each([SubscriptionStatus.PAST_DUE, SubscriptionStatus.GRACE_EXPIRED])(
      'also revives a lapsed %s subscription with a fresh period from the payment',
      async (status) => {
        const sub = subscription({ status });
        arrange(invoice({ kind: SubscriptionInvoiceKind.REACTIVATION }), sub);
        const res = await service.settleInvoicePaid('inv-1', evidence());
        expect(res.outcome).toBe('settled');
        expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
        expect(sub.grace_started_at).toBeNull();
        expect(sub.starts_at.getTime()).toBeGreaterThan(
          new Date('2026-10-02T00:00:00.000Z').getTime(),
        );
      },
    );

    it('is not applied to a CANCELLED subscription', async () => {
      arrange(
        invoice({ kind: SubscriptionInvoiceKind.REACTIVATION }),
        subscription({ status: SubscriptionStatus.CANCELLED }),
      );
      expect(
        (await service.settleInvoicePaid('inv-1', evidence())).outcome,
      ).toBe('settled_unapplied');
    });
  });

  describe('UPGRADE — the plan switches ONLY on payment, with a fresh period (no proration)', () => {
    it('switches to the plan paid for, ACTIVE, a fresh period from the payment, and clears a scheduled downgrade', async () => {
      const inv = invoice({
        kind: SubscriptionInvoiceKind.UPGRADE,
        target_plan_id: 'plan-b',
        amount: '300.00',
      });
      const sub = subscription({
        status: SubscriptionStatus.ACTIVE,
        plan: PLAN_A,
        pending_plan: PLAN_A,
      });
      arrange(inv, sub);
      planRepo.findOne.mockResolvedValueOnce(PLAN_B);
      const before = Date.now();

      const res = await service.settleInvoicePaid(
        'inv-1',
        evidence({ capturedMinorUnits: 30000 }),
      );

      expect(res.outcome).toBe('settled');
      expect(sub.plan).toBe(PLAN_B);
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.pending_plan).toBeNull();
      expect(sub.starts_at.getTime()).toBeGreaterThanOrEqual(before);
      expect(sub.ends_at).toEqual(
        computeNextPeriodEnd(sub.starts_at, PLAN_B as never),
      );
      expect(inv.period_start).toEqual(sub.starts_at);
      expect(emitted(SubscriptionPlanChangedEvent)).toHaveLength(1);
      expect(emitted(SubscriptionPlanChangedEvent)[0][1]).toMatchObject({
        newPlanId: 'plan-b',
      });
      expect(access.invalidate).toHaveBeenCalledWith(TENANT);
    });

    it('trial → paid: the TRIAL subscription becomes ACTIVE on the paid plan', async () => {
      const sub = subscription({ status: SubscriptionStatus.TRIAL });
      arrange(
        invoice({
          kind: SubscriptionInvoiceKind.UPGRADE,
          target_plan_id: 'plan-b',
          amount: '300.00',
        }),
        sub,
      );
      planRepo.findOne.mockResolvedValueOnce(PLAN_B);
      await service.settleInvoicePaid(
        'inv-1',
        evidence({ capturedMinorUnits: 30000 }),
      );
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.plan).toBe(PLAN_B);
    });

    it.each([SubscriptionStatus.PAST_DUE, SubscriptionStatus.GRACE_EXPIRED])(
      'an upgrade paid from %s restores ACTIVE and clears the grace markers',
      async (status) => {
        const sub = subscription({ status });
        arrange(
          invoice({
            kind: SubscriptionInvoiceKind.UPGRADE,
            target_plan_id: 'plan-a',
          }),
          sub,
        );
        await service.settleInvoicePaid('inv-1', evidence());
        expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
        expect(sub.grace_started_at).toBeNull();
        expect(sub.grace_expired_at).toBeNull();
      },
    );

    it.each([
      SubscriptionStatus.CANCELLED,
      SubscriptionStatus.SUSPENDED,
      SubscriptionStatus.PENDING_PAYMENT,
    ])(
      'is NOT applied to a %s subscription (recorded, ALERT)',
      async (status) => {
        const sub = subscription({ status });
        arrange(invoice({ kind: SubscriptionInvoiceKind.UPGRADE }), sub);
        const res = await service.settleInvoicePaid('inv-1', evidence());
        expect(res.outcome).toBe('settled_unapplied');
        expect(sub.status).toBe(status);
      },
    );
  });

  describe('RENEWAL — the next period, plan = what the invoice billed', () => {
    const renewal = (over: Record<string, unknown> = {}) =>
      invoice({
        kind: SubscriptionInvoiceKind.RENEWAL,
        target_plan_id: 'plan-a',
        period_start: new Date('2026-10-01T00:00:00.000Z'), // == the subscription's ends_at
        period_end: new Date('2026-11-01T00:00:00.000Z'),
        ...over,
      });

    it('advances the period from the OLD end (not from the payment), revives ACTIVE, clears grace, and leaves the plan alone', async () => {
      const oldEnd = new Date('2026-10-01T00:00:00.000Z');
      const sub = subscription({
        status: SubscriptionStatus.PAST_DUE,
        ends_at: oldEnd,
      });
      arrange(renewal(), sub);

      const res = await service.settleInvoicePaid('inv-1', evidence());

      expect(res.outcome).toBe('settled');
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.starts_at).toEqual(oldEnd); // continuity: no gap, no overlap
      expect(sub.ends_at).toEqual(
        computeNextPeriodEnd(oldEnd, PLAN_A as never),
      );
      expect(sub.grace_started_at).toBeNull();
      expect(sub.grace_expired_at).toBeNull();
      expect(sub.plan).toBe(PLAN_A);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_SETTLED,
        }),
      );
      expect(emitter.emit).not.toHaveBeenCalled(); // no domain event for a renewal (unchanged)
      expect(email.sendInvoice).toHaveBeenCalled();
    });

    it('applies the SCHEDULED DOWNGRADE when the invoice billed the lower plan, and clears it', async () => {
      const sub = subscription({
        status: SubscriptionStatus.PAST_DUE,
        plan: PLAN_B,
        pending_plan: PLAN_A,
      });
      arrange(renewal({ target_plan_id: 'plan-a' }), sub);
      planRepo.findOne.mockResolvedValueOnce(PLAN_A);

      await service.settleInvoicePaid('inv-1', evidence());

      expect(sub.plan).toBe(PLAN_A);
      expect(sub.pending_plan).toBeNull();
    });

    it('does NOT apply a downgrade that was scheduled AFTER this invoice was issued — it was billed at the old price', async () => {
      const sub = subscription({
        status: SubscriptionStatus.PAST_DUE,
        plan: PLAN_B,
        pending_plan: PLAN_A, // scheduled meanwhile
      });
      arrange(renewal({ target_plan_id: 'plan-b', amount: '300.00' }), sub);

      await service.settleInvoicePaid(
        'inv-1',
        evidence({ capturedMinorUnits: 30000 }),
      );

      expect(sub.plan).toBe(PLAN_B); // still what was paid for
      expect(sub.pending_plan).toBe(PLAN_A); // waits for the NEXT renewal
    });

    it('the period length follows the plan that is now billed (monthly → yearly)', async () => {
      const oldEnd = new Date('2026-10-01T00:00:00.000Z');
      const sub = subscription({
        status: SubscriptionStatus.PAST_DUE,
        ends_at: oldEnd,
      });
      arrange(renewal({ target_plan_id: 'plan-y', amount: '900.00' }), sub);
      planRepo.findOne.mockResolvedValueOnce(PLAN_YEARLY);
      await service.settleInvoicePaid(
        'inv-1',
        evidence({ capturedMinorUnits: 90000 }),
      );
      expect(sub.ends_at).toEqual(
        computeNextPeriodEnd(oldEnd, PLAN_YEARLY as never),
      );
    });

    it('a STALE renewal invoice (the subscription already moved past its period) is recorded but NOT applied — it would advance the clinic twice', async () => {
      const sub = subscription({
        status: SubscriptionStatus.ACTIVE,
        ends_at: new Date('2026-11-01T00:00:00.000Z'), // already renewed once
      });
      arrange(renewal(), sub); // invoice period_start 2026-10-01 ≠ ends_at
      const res = await service.settleInvoicePaid('inv-1', evidence());
      expect(res).toMatchObject({
        outcome: 'settled_unapplied',
        reason: 'renewal_period_stale',
      });
      expect(sub.ends_at).toEqual(new Date('2026-11-01T00:00:00.000Z'));
      expect(subRepo.save).not.toHaveBeenCalled();
    });

    it.each([
      SubscriptionStatus.CANCELLED,
      SubscriptionStatus.SUSPENDED,
      SubscriptionStatus.PENDING_PAYMENT,
    ])('is not applied to a %s subscription', async (status) => {
      arrange(renewal(), subscription({ status }));
      expect(
        (await service.settleInvoicePaid('inv-1', evidence())).outcome,
      ).toBe('settled_unapplied');
    });

    it('an unknown future kind is recorded, nothing applied', async () => {
      arrange(invoice({ kind: 'SOMETHING_NEW' }), subscription());
      const res = await service.settleInvoicePaid('inv-1', evidence());
      expect(res).toMatchObject({
        outcome: 'settled_unapplied',
        reason: 'unknown_kind',
      });
    });
  });

  // ───────────────────────────── saved card ───────────────────────────── //

  describe('the saved card', () => {
    const saved = {
      provider: 'tap',
      customerId: 'cus_1',
      cardId: 'card_1',
      agreementId: 'agr_1',
      recurringCapable: true,
    };

    it('is stored INSIDE the transaction as the default, and linked to the invoice', async () => {
      const inv = invoice();
      arrange(inv, subscription());

      await service.settleInvoicePaid(
        'inv-1',
        evidence({ savedPaymentMethod: saved }),
      );

      expect(methods.upsertDefault).toHaveBeenCalledWith(
        manager,
        TENANT,
        saved,
        'inv-1',
      );
      expect(inv.payment_method_id).toBe('pm-1');
    });

    it("is stored even for a legacy invoice (the card is the clinic's, whatever the invoice buys)", async () => {
      arrange(invoice({ kind: null }), subscription());
      await service.settleInvoicePaid(
        'inv-1',
        evidence({ savedPaymentMethod: saved }),
      );
      expect(methods.upsertDefault).toHaveBeenCalled();
    });

    it('a card that cannot be attached (belongs to another tenant) does not stop the payment from settling', async () => {
      methods.upsertDefault.mockResolvedValueOnce(null);
      const inv = invoice();
      arrange(inv, subscription());
      const res = await service.settleInvoicePaid(
        'inv-1',
        evidence({ savedPaymentMethod: saved }),
      );
      expect(res.outcome).toBe('settled');
      expect(inv.payment_method_id).toBeNull();
    });

    it('nothing is stored when the charge saved no card', async () => {
      arrange(invoice(), subscription());
      await service.settleInvoicePaid('inv-1', evidence());
      expect(methods.upsertDefault).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────── after commit ───────────────────────────── //

  describe('after the commit', () => {
    it('never rolls the settlement back because a notification failed', async () => {
      arrange(invoice(), subscription());
      audit.record.mockRejectedValueOnce(new Error('audit down'));
      email.sendInvoice.mockImplementationOnce(() => {
        throw new Error('smtp down');
      });
      const res = await service.settleInvoicePaid('inv-1', evidence());
      expect(res.outcome).toBe('settled');
    });

    it('sends no receipt when the clinic has no contact e-mail', async () => {
      tenants.findOne.mockResolvedValueOnce({
        id: TENANT,
        contact_email: null,
      });
      arrange(invoice(), subscription());
      await service.settleInvoicePaid('inv-1', evidence());
      expect(email.sendInvoice).not.toHaveBeenCalled();
    });

    it('the transaction itself failing (a database error) propagates so the gateway retries', async () => {
      invoiceRepo.findOne.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.settleInvoicePaid('inv-1', evidence()),
      ).rejects.toThrow('db down');
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
