import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SubscriptionsProcessor } from './subscriptions.processor';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { User } from '../../entities/Auth&RBAC/User';
import { SubscriptionStatus } from '../../entities/enums';
import { EmailService } from '../../modules/email/email.service';
import { RenewalService } from '../../modules/subscription-billing/renewal.service';
import { PendingPaymentExpiryService } from '../../modules/subscription-billing/pending-payment-expiry.service';
import { DistributedLockService } from '../../queue/distributed-lock.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../../modules/platform/platform-admin-audit.service';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('SubscriptionsProcessor', () => {
  let processor: SubscriptionsProcessor;
  let subscriptions: MockRepository;
  let users: MockRepository;
  let email: { sendSubscriptionNotification: jest.Mock };
  let audit: { record: jest.Mock };
  let renewal: { processDueBills: jest.Mock };
  let pendingExpiry: { expireAbandoned: jest.Mock };
  let lock: { acquire: jest.Mock; release: jest.Mock };
  let metrics: { setWorkerHeartbeat: jest.Mock };
  let qb: ReturnType<typeof createMockQueryBuilder>;

  const GRACE_DAYS = 14;

  beforeEach(async () => {
    subscriptions = createMockRepository();
    users = createMockRepository();
    qb = createMockQueryBuilder();
    (qb.getRawMany as jest.Mock).mockResolvedValue([]); // no operators by default
    (users.createQueryBuilder as jest.Mock).mockReturnValue(qb);
    email = { sendSubscriptionNotification: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    renewal = {
      processDueBills: jest.fn().mockResolvedValue({
        due: 0,
        attempted: 0,
        settled: 0,
        declined: 0,
        skipped: 0,
      }),
    };
    pendingExpiry = {
      expireAbandoned: jest
        .fn()
        .mockResolvedValue({ scanned: 0, cancelled: 0, skipped: 0 }),
    };
    lock = {
      acquire: jest.fn().mockResolvedValue('token'),
      release: jest.fn().mockResolvedValue(undefined),
    };
    metrics = { setWorkerHeartbeat: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsProcessor,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: EmailService, useValue: email },
        { provide: PlatformAdminAuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(GRACE_DAYS) },
        },
        { provide: RenewalService, useValue: renewal },
        { provide: PendingPaymentExpiryService, useValue: pendingExpiry },
        { provide: DistributedLockService, useValue: lock },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();
    processor = moduleRef.get(SubscriptionsProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  // `subscriptions.find` is called by process()'s existing due-count sweep
  // FIRST, then by the 4 new sweeps (warnExpiringSoon, transitionToGrace,
  // warnGraceEndingSoon, transitionGraceExpired) in order — default every
  // call to empty so a test only has to prime the ONE call it cares about.
  function primeEmptyExcept(overrides: Partial<Record<number, unknown[]>>) {
    let call = 0;
    (subscriptions.find as jest.Mock).mockImplementation(async () => {
      const result = overrides[call] ?? [];
      call += 1;
      return result;
    });
  }

  interface RenewalCheckResult {
    due: number;
    tenants: number;
    expiringSoonWarned: number;
    enteredGrace: number;
    graceEndingSoonWarned: number;
    graceExpired: number;
  }

  /** T082 — `process()`'s return type is now a union across the two jobs
   *  this queue carries; every test here exercises `renewalCheck`
   *  specifically (asserted via the job name below), so the shape is known. */
  async function runCheck(): Promise<RenewalCheckResult> {
    return processor.process({
      name: 'subscriptions.renewalCheck',
    } as any) as unknown as Promise<RenewalCheckResult>;
  }

  it('counts subscriptions due for renewal grouped by tenant (pre-existing behavior, unchanged)', async () => {
    primeEmptyExcept({
      0: [
        { tenant: { id: 't1' } },
        { tenant: { id: 't1' } },
        { tenant: { id: 't2' } },
      ],
    });
    const result = await runCheck();
    expect(result.due).toBe(3);
    expect(result.tenants).toBe(2);
  });

  it('returns zero when nothing is due', async () => {
    primeEmptyExcept({});
    const result = await runCheck();
    expect(result.due).toBe(0);
    expect(result.tenants).toBe(0);
  });

  it('pages through a full page followed by a partial page (L8)', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      tenant: { id: `t${i % 3}` },
    }));
    const lastPage = [{ tenant: { id: 't0' } }, { tenant: { id: 't3' } }];
    primeEmptyExcept({ 0: fullPage, 1: lastPage });

    const result = await runCheck();

    expect(result.due).toBe(1002);
    expect(result.tenants).toBe(4);
  });

  describe('FND-031 — grace state machine', () => {
    const TENANT = { id: 'tenant-1', contact_email: 'clinic@example.test' };

    it('transitions an ACTIVE subscription past ends_at into PAST_DUE, sets grace_started_at, audits, and notifies', async () => {
      const sub = {
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        ends_at: new Date(Date.now() - 86_400_000),
        tenant: TENANT,
        plan: { name: 'Pro' },
      };
      // sweep order: due-count(0), expiring-soon(1), transitionToGrace(2), grace-ending-soon(3), grace-expired(4)
      primeEmptyExcept({ 2: [sub] });

      const result = await runCheck();

      expect(subscriptions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SubscriptionStatus.PAST_DUE,
          grace_started_at: expect.any(Date),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_ENTERED_GRACE,
          userId: undefined,
          entityId: 'sub-1',
          tenantId: 'tenant-1',
        }),
      );
      expect(email.sendSubscriptionNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'clinic@example.test',
          event: 'entered_grace',
          tenantId: 'tenant-1',
        }),
      );
      expect(result.enteredGrace).toBe(1);
    });

    it('transitions a PAST_DUE subscription whose grace window elapsed into GRACE_EXPIRED and audits (no separate notification)', async () => {
      const sub = {
        id: 'sub-2',
        status: SubscriptionStatus.PAST_DUE,
        grace_started_at: new Date(Date.now() - (GRACE_DAYS + 1) * 86_400_000),
        tenant: TENANT,
      };
      primeEmptyExcept({ 4: [sub] });

      const result = await runCheck();

      expect(subscriptions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: SubscriptionStatus.GRACE_EXPIRED,
          grace_expired_at: expect.any(Date),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_GRACE_EXPIRED,
          entityId: 'sub-2',
        }),
      );
      expect(result.graceExpired).toBe(1);
    });

    it('warns before expiry (point 1) for an ACTIVE subscription within the warning window', async () => {
      const sub = {
        id: 'sub-3',
        status: SubscriptionStatus.ACTIVE,
        ends_at: new Date(Date.now() + 86_400_000), // 1 day out — within the 3-day window
        tenant: TENANT,
        plan: { name: 'Pro' },
      };
      primeEmptyExcept({ 1: [sub] });

      const result = await runCheck();

      expect(email.sendSubscriptionNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'expiring_soon',
          to: 'clinic@example.test',
        }),
      );
      expect(result.expiringSoonWarned).toBe(1);
    });

    it('warns before grace end (point 3) for a PAST_DUE subscription approaching its grace boundary', async () => {
      const sub = {
        id: 'sub-4',
        status: SubscriptionStatus.PAST_DUE,
        grace_started_at: new Date(Date.now() - (GRACE_DAYS - 1) * 86_400_000), // 1 day of grace left
        tenant: TENANT,
      };
      primeEmptyExcept({ 3: [sub] });

      const result = await runCheck();

      expect(email.sendSubscriptionNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'grace_ending_soon',
          to: 'clinic@example.test',
        }),
      );
      expect(result.graceEndingSoonWarned).toBe(1);
    });

    it('notifies platform operators in addition to the tenant', async () => {
      (qb.getRawMany as jest.Mock).mockResolvedValueOnce([
        { email: 'admin@platform.test' },
      ]);
      const sub = {
        id: 'sub-5',
        status: SubscriptionStatus.ACTIVE,
        ends_at: new Date(Date.now() - 86_400_000),
        tenant: TENANT,
        plan: {},
      };
      primeEmptyExcept({ 2: [sub] });

      await runCheck();

      const recipients = (
        email.sendSubscriptionNotification as jest.Mock
      ).mock.calls.map((c) => c[0].to);
      expect(recipients).toEqual(
        expect.arrayContaining(['clinic@example.test', 'admin@platform.test']),
      );
    });

    // FR-H014/T156 gap-closure: an operator's own recorded locale (M-08) must
    // reach their copy of the notification; the tenant's raw contact_email
    // has no linked User row, so it has no locale signal (falls back to
    // EMAIL_DEFAULT_LOCALE) — pre-existing, unchanged behavior, not a gap.
    it("[T156] forwards each operator's own preferred_locale, leaving the tenant contact email's locale unset", async () => {
      (qb.getRawMany as jest.Mock).mockResolvedValueOnce([
        { email: 'admin@platform.test', preferredLocale: 'ar' },
      ]);
      const sub = {
        id: 'sub-5b',
        status: SubscriptionStatus.ACTIVE,
        ends_at: new Date(Date.now() - 86_400_000),
        tenant: TENANT,
        plan: {},
      };
      primeEmptyExcept({ 2: [sub] });

      await runCheck();

      const calls = (
        email.sendSubscriptionNotification as jest.Mock
      ).mock.calls.map((c) => c[0]);
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: 'admin@platform.test', locale: 'ar' }),
          expect.objectContaining({
            to: 'clinic@example.test',
            locale: undefined,
          }),
        ]),
      );
    });

    // FR-B007 pre-T080: the `renewalCheck` sweep never charges anything —
    // that capability was, and remains, entirely absent from THIS path. T080
    // (spec 014, US5) deliberately adds automatic re-billing, but on a
    // SEPARATE job (`renewalBill`, see the describe block below) — this
    // still proves `renewalCheck` itself never reaches RenewalService.
    it('never calls RenewalService (billing) from the renewalCheck sweep', async () => {
      const sub = {
        id: 'sub-6',
        status: SubscriptionStatus.ACTIVE,
        ends_at: new Date(Date.now() - 86_400_000),
        tenant: TENANT,
        plan: {},
      };
      primeEmptyExcept({ 2: [sub] });
      await runCheck();
      expect(renewal.processDueBills).not.toHaveBeenCalled();
    });
  });

  describe('subscriptions.pendingPaymentExpiry job routing', () => {
    it('routes to PendingPaymentExpiryService, lock-guarded, and never runs the grace sweep or the bill run', async () => {
      pendingExpiry.expireAbandoned.mockResolvedValueOnce({
        scanned: 2,
        cancelled: 1,
        skipped: 1,
      });
      const result = await processor.process({
        name: 'subscriptions.pendingPaymentExpiry',
      } as any);
      expect(lock.acquire).toHaveBeenCalledWith(
        'lock:subscriptions-pending-payment-expiry',
        expect.any(Number),
      );
      expect(pendingExpiry.expireAbandoned).toHaveBeenCalledTimes(1);
      expect(renewal.processDueBills).not.toHaveBeenCalled();
      expect(subscriptions.find).not.toHaveBeenCalled();
      expect(lock.release).toHaveBeenCalledWith(
        'lock:subscriptions-pending-payment-expiry',
        'token',
      );
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'subscriptions.pendingPaymentExpiry',
      );
      expect(result).toEqual({ scanned: 2, cancelled: 1, skipped: 1 });
    });

    it('skips when the lock is already held', async () => {
      lock.acquire.mockResolvedValueOnce(null);
      const result = await processor.process({
        name: 'subscriptions.pendingPaymentExpiry',
      } as any);
      expect(result).toEqual({ skipped: true });
      expect(pendingExpiry.expireAbandoned).not.toHaveBeenCalled();
    });

    it('releases the lock even when the sweep throws', async () => {
      pendingExpiry.expireAbandoned.mockRejectedValueOnce(new Error('boom'));
      await expect(
        processor.process({ name: 'subscriptions.pendingPaymentExpiry' } as any),
      ).rejects.toThrow('boom');
      expect(lock.release).toHaveBeenCalledWith(
        'lock:subscriptions-pending-payment-expiry',
        'token',
      );
    });
  });

  describe('T082 — renewalBill job routing', () => {
    it('routes subscriptions.renewalBill to RenewalService.processDueBills, lock-guarded', async () => {
      const result = await processor.process({
        name: 'subscriptions.renewalBill',
      } as any);
      expect(lock.acquire).toHaveBeenCalledWith(
        'lock:subscriptions-renewal-bill',
        expect.any(Number),
      );
      expect(renewal.processDueBills).toHaveBeenCalledTimes(1);
      expect(lock.release).toHaveBeenCalledWith(
        'lock:subscriptions-renewal-bill',
        'token',
      );
      expect(metrics.setWorkerHeartbeat).toHaveBeenCalledWith(
        'subscriptions.renewalBill',
      );
      expect(result).toMatchObject({
        due: 0,
        attempted: 0,
        settled: 0,
        declined: 0,
        skipped: 0,
      });
    });

    it('skips without calling RenewalService when the lock is already held', async () => {
      lock.acquire.mockResolvedValueOnce(null);
      const result = await processor.process({
        name: 'subscriptions.renewalBill',
      } as any);
      expect(renewal.processDueBills).not.toHaveBeenCalled();
      expect(result).toEqual({ skipped: true });
    });

    it('releases the lock even when RenewalService throws', async () => {
      renewal.processDueBills.mockRejectedValueOnce(new Error('boom'));
      await expect(
        processor.process({ name: 'subscriptions.renewalBill' } as any),
      ).rejects.toThrow('boom');
      expect(lock.release).toHaveBeenCalledWith(
        'lock:subscriptions-renewal-bill',
        'token',
      );
    });

    it('never re-runs the grace-check sweep for a renewalBill job', async () => {
      await processor.process({ name: 'subscriptions.renewalBill' } as any);
      expect(subscriptions.find).not.toHaveBeenCalled();
    });
  });
});
