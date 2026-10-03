import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RenewalService } from './renewal.service';
import { BillingService } from './billing.service';
import { computeNextPeriodEnd } from './subscription-period.util';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import {
  BillingCycle,
  InvoiceStatus,
  SubscriptionInvoiceKind,
  SubscriptionStatus,
} from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { SystemSettingService } from '../platform/system-setting.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';
import { EmailService } from '../email/email.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const GRACE_DAYS = 14;
const TENANT = { id: 'tenant-1', contact_email: 'clinic@example.test' };
const PLAN = {
  id: 'plan-1',
  name: 'Pro',
  price: '100.00',
  billing_cycle: BillingCycle.MONTHLY,
};
const CHEAPER_PLAN = {
  id: 'plan-0',
  name: 'Basic',
  price: '40.00',
  billing_cycle: BillingCycle.MONTHLY,
};

describe('RenewalService (T080/T081/T085/T086, US5)', () => {
  let service: RenewalService;
  let subscriptions: MockRepository;
  let invoices: MockRepository;
  let billing: {
    payInvoice: jest.Mock;
    generateInvoice: jest.Mock;
    voidSupersededOpenInvoices: jest.Mock;
    isPaymentInFlight: jest.Mock;
    providerName: string;
  };
  let platformSettings: { getTyped: jest.Mock };
  let audit: { record: jest.Mock };
  let email: { sendInvoice: jest.Mock; sendPaymentFailed: jest.Mock };

  function baseSubscription(
    overrides: Partial<Subscription> = {},
  ): Subscription {
    return {
      id: 'sub-1',
      status: SubscriptionStatus.PAST_DUE,
      auto_renew: true,
      starts_at: new Date('2026-08-01T00:00:00.000Z'),
      ends_at: new Date('2026-08-29T00:00:00.000Z'),
      grace_started_at: new Date('2026-08-29T00:00:00.000Z'),
      grace_expired_at: null,
      pending_plan: null,
      tenant: TENANT,
      plan: PLAN,
      ...overrides,
    } as unknown as Subscription;
  }

  /** One page holding `sub`, then the (empty) terminating page. */
  const pageOf = (...subs: Subscription[]) => {
    subscriptions.find = jest
      .fn()
      .mockResolvedValueOnce(subs)
      .mockResolvedValueOnce([]);
  };

  beforeEach(async () => {
    subscriptions = createMockRepository();
    invoices = createMockRepository();
    billing = {
      payInvoice: jest.fn(),
      generateInvoice: jest.fn(),
      voidSupersededOpenInvoices: jest.fn().mockResolvedValue(0),
      isPaymentInFlight: jest.fn().mockReturnValue(false),
      providerName: 'tap',
    };
    platformSettings = { getTyped: jest.fn().mockResolvedValue('SAR') };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    email = { sendInvoice: jest.fn(), sendPaymentFailed: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RenewalService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        {
          provide: getRepositoryToken(SubscriptionInvoice),
          useValue: invoices,
        },
        { provide: BillingService, useValue: billing },
        { provide: SystemSettingService, useValue: platformSettings },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: EmailService, useValue: email },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(GRACE_DAYS) },
        },
      ],
    }).compile();
    service = moduleRef.get(RenewalService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('processDueBills — eligibility scan', () => {
    it('scans only PAST_DUE, auto-renewing subscriptions, with the plan AND the scheduled downgrade loaded', async () => {
      subscriptions.find = jest.fn().mockResolvedValueOnce([]);
      await service.processDueBills();
      expect(subscriptions.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: SubscriptionStatus.PAST_DUE,
            auto_renew: true,
          }),
          relations: { tenant: true, plan: true, pending_plan: true },
        }),
      );
    });

    it('reports zero due when nothing is PAST_DUE', async () => {
      subscriptions.find = jest.fn().mockResolvedValueOnce([]);
      const result = await service.processDueBills();
      expect(result).toEqual({
        due: 0,
        attempted: 0,
        settled: 0,
        declined: 0,
        pending: 0,
        skipped: 0,
      });
    });
  });

  describe('first attempt — bills the NEXT period (the first-renewal period-key fix)', () => {
    it('creates the renewal invoice for the period that STARTS where the paid one ends, then charges it', async () => {
      const sub = baseSubscription();
      pageOf(sub);
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      const createdInvoice = {
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
        amount: '100.00',
      };
      billing.generateInvoice.mockResolvedValueOnce(createdInvoice);
      billing.payInvoice.mockResolvedValueOnce({
        ...createdInvoice,
        status: InvoiceStatus.PAID,
        provider_reference: 'gw-ref-1',
      });
      const endsAt = sub.ends_at;

      const result = await service.processDueBills();

      expect(billing.generateInvoice).toHaveBeenCalledWith(
        TENANT.id,
        sub.id,
        100,
        endsAt, // period_start = the paid period's END, never its start
        computeNextPeriodEnd(endsAt, PLAN as never),
        'SAR',
        InvoiceStatus.OPEN,
        {
          kind: SubscriptionInvoiceKind.RENEWAL,
          targetPlanId: 'plan-1',
          provider: 'tap',
        },
      );
      expect(billing.payInvoice).toHaveBeenCalledWith(TENANT.id, 'inv-1');
      expect(result.attempted).toBe(1);
      expect(result.settled).toBe(1);
    });

    it('REGRESSION: a paid subscription whose creation invoice is PAID is still renewed (it used to be skipped forever)', async () => {
      const sub = baseSubscription();
      pageOf(sub);
      // The creation invoice owns period_start = starts_at and is PAID; nothing
      // exists yet for period_start = ends_at. Keyed on the OLD column the lookup
      // would find the PAID invoice and the renewal would be skipped.
      invoices.findOne = jest
        .fn()
        .mockImplementation(async ({ where }) =>
          where.period_start === sub.starts_at
            ? { id: 'inv-creation', status: InvoiceStatus.PAID }
            : null,
        );
      const created = {
        id: 'inv-renewal',
        retry_count: 0,
        next_retry_at: null,
      };
      billing.generateInvoice.mockResolvedValueOnce(created);
      billing.payInvoice.mockResolvedValueOnce({
        ...created,
        status: InvoiceStatus.PAID,
      });

      const result = await service.processDueBills();

      expect(billing.generateInvoice).toHaveBeenCalledTimes(1);
      expect(billing.payInvoice).toHaveBeenCalledWith(TENANT.id, 'inv-renewal');
      expect(result.settled).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('looks the period up by (subscription, ends_at) and ignores a VOID invoice', async () => {
      const sub = baseSubscription();
      pageOf(sub);
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      billing.generateInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
      });
      billing.payInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        status: InvoiceStatus.PAID,
      });

      await service.processDueBills();

      expect(invoices.findOne).toHaveBeenCalledWith({
        where: {
          subscription_id: 'sub-1',
          period_start: sub.ends_at,
          status: expect.objectContaining({ _type: 'not' }),
        },
      });
    });

    it('supersedes an idle legacy / upgrade-quote invoice BEFORE issuing its own (they hold the single OPEN slot)', async () => {
      pageOf(baseSubscription());
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      const order: string[] = [];
      billing.voidSupersededOpenInvoices.mockImplementation(async () => {
        order.push('void');
        return 1;
      });
      billing.generateInvoice.mockImplementation(async () => {
        order.push('generate');
        return { id: 'inv-1', retry_count: 0, next_retry_at: null };
      });
      billing.payInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        status: InvoiceStatus.PAID,
      });

      await service.processDueBills();

      expect(order).toEqual(['void', 'generate']);
      expect(billing.voidSupersededOpenInvoices).toHaveBeenCalledWith(
        'sub-1',
        expect.stringContaining('Superseded'),
      );
    });

    it('bills the SCHEDULED DOWNGRADE: price, target plan and period length all come from the pending plan', async () => {
      const sub = baseSubscription({
        pending_plan: CHEAPER_PLAN as never,
      });
      pageOf(sub);
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      billing.generateInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
      });
      billing.payInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        status: InvoiceStatus.PAID,
      });

      await service.processDueBills();

      expect(billing.generateInvoice).toHaveBeenCalledWith(
        TENANT.id,
        sub.id,
        40,
        sub.ends_at,
        computeNextPeriodEnd(sub.ends_at, CHEAPER_PLAN as never),
        'SAR',
        InvoiceStatus.OPEN,
        expect.objectContaining({ targetPlanId: 'plan-0' }),
      );
    });

    it('reuses an existing OPEN invoice for the next period instead of creating a second one', async () => {
      pageOf(baseSubscription());
      const existing = {
        id: 'inv-existing',
        status: InvoiceStatus.OPEN,
        retry_count: 0,
        next_retry_at: null,
        amount: '100.00',
      };
      invoices.findOne = jest.fn().mockResolvedValueOnce(existing);
      billing.payInvoice.mockResolvedValueOnce({
        ...existing,
        status: InvoiceStatus.PAID,
      });

      await service.processDueBills();

      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(billing.voidSupersededOpenInvoices).not.toHaveBeenCalled();
      expect(billing.payInvoice).toHaveBeenCalledWith(
        TENANT.id,
        'inv-existing',
      );
    });

    it('skips a subscription whose next-period invoice is already terminal (PAID/REFUNDED)', async () => {
      pageOf(baseSubscription());
      invoices.findOne = jest
        .fn()
        .mockResolvedValueOnce({ id: 'inv-paid', status: InvoiceStatus.PAID });

      const result = await service.processDueBills();

      expect(billing.payInvoice).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    it('on a unique-violation race, fetches the invoice the winning attempt created instead of failing', async () => {
      pageOf(baseSubscription());
      const winner = {
        id: 'inv-winner',
        status: InvoiceStatus.OPEN,
        retry_count: 0,
        next_retry_at: null,
        amount: '100.00',
      };
      invoices.findOne = jest
        .fn()
        .mockResolvedValueOnce(null) // first check: none yet
        .mockResolvedValueOnce(winner); // re-fetch after the race
      billing.generateInvoice.mockRejectedValueOnce({ code: '23505' });
      billing.payInvoice.mockResolvedValueOnce({
        ...winner,
        status: InvoiceStatus.PAID,
      });

      const result = await service.processDueBills();

      expect(billing.payInvoice).toHaveBeenCalledWith(TENANT.id, 'inv-winner');
      expect(result.attempted).toBe(1);
    });

    it('skips (never errors) when the OPEN slot is held by an invoice the clinic is paying: nothing to re-fetch for this period', async () => {
      pageOf(baseSubscription());
      invoices.findOne = jest.fn().mockResolvedValue(null);
      billing.generateInvoice.mockRejectedValueOnce({ code: '23505' });

      const result = await service.processDueBills();

      expect(billing.payInvoice).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    it('rethrows an unexpected database error as a skipped sweep entry, not a crash of the whole run', async () => {
      pageOf(baseSubscription());
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      billing.generateInvoice.mockRejectedValueOnce(new Error('db down'));

      const result = await service.processDueBills();

      expect(result.skipped).toBe(1);
    });
  });

  describe('retry due-ness', () => {
    it('skips an invoice whose next_retry_at is still in the future', async () => {
      pageOf(baseSubscription());
      invoices.findOne = jest.fn().mockResolvedValueOnce({
        id: 'inv-2',
        status: InvoiceStatus.OPEN,
        retry_count: 1,
        next_retry_at: new Date(Date.now() + 86_400_000),
      });

      const result = await service.processDueBills();

      expect(billing.payInvoice).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    it('attempts an invoice whose next_retry_at has passed', async () => {
      pageOf(baseSubscription());
      const due = {
        id: 'inv-3',
        status: InvoiceStatus.OPEN,
        retry_count: 1,
        next_retry_at: new Date(Date.now() - 1000),
        amount: '100.00',
      };
      invoices.findOne = jest.fn().mockResolvedValueOnce(due);
      billing.payInvoice.mockResolvedValueOnce({
        ...due,
        status: InvoiceStatus.PAID,
      });

      const result = await service.processDueBills();

      expect(billing.payInvoice).toHaveBeenCalledWith(TENANT.id, 'inv-3');
      expect(result.attempted).toBe(1);
    });
  });

  describe('a clinic paying by hand right now', () => {
    it('stands down — no charge, no attempt audit — while a hosted checkout / claim is in flight', async () => {
      pageOf(baseSubscription());
      invoices.findOne = jest.fn().mockResolvedValueOnce({
        id: 'inv-1',
        status: InvoiceStatus.OPEN,
        retry_count: 0,
        next_retry_at: null,
        checkout_started_at: new Date(),
      });
      billing.isPaymentInFlight.mockReturnValueOnce(true);

      const result = await service.processDueBills();

      expect(billing.payInvoice).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.attempted).toBe(0);
    });
  });

  describe('outcome of the charge', () => {
    it('SETTLED: counts it and leaves the subscription to the settle path (this service no longer advances it)', async () => {
      const sub = baseSubscription();
      pageOf(sub);
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      billing.generateInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
      });
      billing.payInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        status: InvoiceStatus.PAID,
      });

      const result = await service.processDueBills();

      expect(result.settled).toBe(1);
      expect(subscriptions.save).not.toHaveBeenCalled();
      expect(sub.status).toBe(SubscriptionStatus.PAST_DUE); // untouched here
      // The attempt is audited here; the SETTLED audit + receipt come from the settle path.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_ATTEMPTED,
        }),
      );
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_SETTLED,
        }),
      );
      expect(email.sendInvoice).not.toHaveBeenCalled();
    });

    it('PENDING (provider accepted, outcome unknown): an attempt, but neither settled nor declined — no retry burned, no "payment failed" e-mail', async () => {
      pageOf(baseSubscription());
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      billing.generateInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
      });
      billing.payInvoice.mockResolvedValueOnce({
        id: 'inv-1',
        status: InvoiceStatus.OPEN,
        checkout_charge_id: 'chg_1',
      });

      const result = await service.processDueBills();

      expect(result).toMatchObject({
        attempted: 1,
        pending: 1,
        settled: 0,
        declined: 0,
      });
      expect(invoices.save).not.toHaveBeenCalled();
      expect(email.sendPaymentFailed).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_DECLINED,
        }),
      );
    });
  });

  describe('onDeclined — retry bookkeeping only, never touches Subscription.status', () => {
    it('bumps retry_count and schedules a +1 day retry on the first decline', async () => {
      const sub = baseSubscription({
        grace_started_at: new Date(
          Date.now() + 10 * 86_400_000,
        ) as unknown as Date,
      });
      pageOf(sub);
      const invoice = {
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
        amount: '100.00',
        failure_reason: null,
        failure_class: null,
      };
      invoices.findOne = jest
        .fn()
        .mockResolvedValueOnce(null) // create path check
        .mockResolvedValueOnce({
          ...invoice,
          failure_reason: 'Card declined',
          failure_class: null,
        }); // re-fetch in onDeclined
      billing.generateInvoice.mockResolvedValueOnce(invoice);
      billing.payInvoice.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Payment was declined',
        }),
      );

      const result = await service.processDueBills();

      expect(subscriptions.save).not.toHaveBeenCalled();
      expect(invoices.save).toHaveBeenCalledWith(
        expect.objectContaining({
          retry_count: 1,
          next_retry_at: expect.any(Date),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_DECLINED,
        }),
      );
      expect(email.sendPaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          to: TENANT.contact_email,
          reason: 'Card declined',
        }),
      );
      expect(result.declined).toBe(1);
    });

    it('stops scheduling retries once the next slot would fall at or past grace expiry', async () => {
      const graceStarted = new Date(
        Date.now() - (GRACE_DAYS - 0.5) * 86_400_000,
      ); // half a day of grace left
      pageOf(baseSubscription({ grace_started_at: graceStarted }));
      const invoice = {
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
        amount: '100.00',
      };
      invoices.findOne = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...invoice });
      billing.generateInvoice.mockResolvedValueOnce(invoice);
      billing.payInvoice.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'declined' }),
      );

      await service.processDueBills();

      // The +1 day retry would land AFTER grace expiry (0.5 days away) — no retry scheduled.
      expect(invoices.save).toHaveBeenCalledWith(
        expect.objectContaining({ retry_count: 1, next_retry_at: null }),
      );
    });

    it('stops after the third retry (schedule exhausted) regardless of remaining grace', async () => {
      pageOf(
        baseSubscription({
          grace_started_at: new Date(Date.now() + 30 * 86_400_000),
        }),
      );
      const existing = {
        id: 'inv-1',
        status: InvoiceStatus.OPEN,
        retry_count: 3,
        next_retry_at: new Date(Date.now() - 1000),
        amount: '100.00',
      };
      invoices.findOne = jest
        .fn()
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce({ ...existing });
      billing.payInvoice.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'declined' }),
      );

      await service.processDueBills();

      expect(invoices.save).toHaveBeenCalledWith(
        expect.objectContaining({ retry_count: 4, next_retry_at: null }),
      );
    });
  });

  describe('concurrent-claim conflict — not a decline', () => {
    it('treats a 409 from payInvoice as skipped, not declined, and records no decline audit', async () => {
      pageOf(baseSubscription());
      const invoice = {
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
        amount: '100.00',
      };
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      billing.generateInvoice.mockResolvedValueOnce(invoice);
      billing.payInvoice.mockRejectedValueOnce(
        new AppError(ErrorCode.CONFLICT, { message: 'already claimed' }),
      );

      const result = await service.processDueBills();

      expect(result.skipped).toBe(1);
      expect(result.declined).toBe(0);
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_DECLINED,
        }),
      );
    });
  });
});
