import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RenewalService } from './renewal.service';
import { BillingService } from './billing.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, SubscriptionStatus } from '../../entities/enums';
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
const PLAN = { id: 'plan-1', name: 'Pro', price: '100.00' };

describe('RenewalService (T080/T081/T085/T086, US5)', () => {
  let service: RenewalService;
  let subscriptions: MockRepository;
  let invoices: MockRepository;
  let billing: { payInvoice: jest.Mock; generateInvoice: jest.Mock };
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
      tenant: TENANT,
      plan: PLAN,
      ...overrides,
    } as unknown as Subscription;
  }

  beforeEach(async () => {
    subscriptions = createMockRepository();
    invoices = createMockRepository();
    billing = { payInvoice: jest.fn(), generateInvoice: jest.fn() };
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
    it('scans only PAST_DUE, auto-renewing subscriptions', async () => {
      subscriptions.find = jest.fn().mockResolvedValueOnce([]);
      await service.processDueBills();
      expect(subscriptions.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: SubscriptionStatus.PAST_DUE,
            auto_renew: true,
          }),
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
        skipped: 0,
      });
    });
  });

  describe('first attempt — creates the period invoice', () => {
    it('creates a new invoice for the current period when none exists, then charges it', async () => {
      const sub = baseSubscription();
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
        provider_reference: 'gw-ref-1',
      });
      // Snapshotted BEFORE the call: onSettled mutates this SAME `sub`
      // object's starts_at/ends_at in place once the charge succeeds.
      const originalStartsAt = sub.starts_at;
      const originalEndsAt = sub.ends_at;

      const result = await service.processDueBills();

      expect(billing.generateInvoice).toHaveBeenCalledWith(
        TENANT.id,
        sub.id,
        100,
        originalStartsAt,
        originalEndsAt,
        'SAR',
      );
      expect(billing.payInvoice).toHaveBeenCalledWith(TENANT.id, 'inv-1');
      expect(result.attempted).toBe(1);
      expect(result.settled).toBe(1);
    });

    it('reuses an existing OPEN invoice for the current period instead of creating a second one', async () => {
      const sub = baseSubscription();
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
        provider_reference: 'gw-ref-2',
      });

      await service.processDueBills();

      expect(billing.generateInvoice).not.toHaveBeenCalled();
      expect(billing.payInvoice).toHaveBeenCalledWith(
        TENANT.id,
        'inv-existing',
      );
    });

    it('skips a subscription whose current-period invoice is already terminal (PAID/VOID/REFUNDED)', async () => {
      const sub = baseSubscription();
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
      invoices.findOne = jest
        .fn()
        .mockResolvedValueOnce({ id: 'inv-paid', status: InvoiceStatus.PAID });

      const result = await service.processDueBills();

      expect(billing.payInvoice).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
    });

    it('on a unique-violation race, fetches the invoice the winning attempt created instead of failing', async () => {
      const sub = baseSubscription();
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
        provider_reference: 'gw-ref-3',
      });

      const result = await service.processDueBills();

      expect(billing.payInvoice).toHaveBeenCalledWith(TENANT.id, 'inv-winner');
      expect(result.attempted).toBe(1);
    });
  });

  describe('retry due-ness', () => {
    it('skips an invoice whose next_retry_at is still in the future', async () => {
      const sub = baseSubscription();
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
      const sub = baseSubscription();
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
        provider_reference: 'gw-ref-4',
      });

      const result = await service.processDueBills();

      expect(billing.payInvoice).toHaveBeenCalledWith(TENANT.id, 'inv-3');
      expect(result.attempted).toBe(1);
    });
  });

  describe('onSettled — successful charge revives the subscription', () => {
    it('reverts to ACTIVE, advances the period, clears grace, audits and emails', async () => {
      const sub = baseSubscription();
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
      invoices.findOne = jest.fn().mockResolvedValueOnce(null);
      const invoice = {
        id: 'inv-1',
        retry_count: 0,
        next_retry_at: null,
        amount: '100.00',
      };
      billing.generateInvoice.mockResolvedValueOnce(invoice);
      billing.payInvoice.mockResolvedValueOnce({
        ...invoice,
        provider_reference: 'gw-ref-5',
      });
      const originalEndsAt = sub.ends_at; // snapshotted before the mutating call

      await service.processDueBills();

      expect(subscriptions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SubscriptionStatus.ACTIVE,
          starts_at: originalEndsAt, // old end becomes new start
          grace_started_at: null,
          grace_expired_at: null,
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_RENEWAL_SETTLED,
          entityId: sub.id,
        }),
      );
      expect(email.sendInvoice).toHaveBeenCalledWith(
        expect.objectContaining({ to: TENANT.contact_email }),
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
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
      const sub = baseSubscription({ grace_started_at: graceStarted });
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
      const sub = baseSubscription({
        grace_started_at: new Date(Date.now() + 30 * 86_400_000),
      });
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
      const sub = baseSubscription();
      subscriptions.find = jest
        .fn()
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);
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
