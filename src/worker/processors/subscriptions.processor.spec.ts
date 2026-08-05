import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SubscriptionsProcessor } from './subscriptions.processor';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { User } from '../../entities/Auth&RBAC/User';
import { SubscriptionStatus } from '../../entities/enums';
import { EmailService } from '../../modules/email/email.service';
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

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsProcessor,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: EmailService, useValue: email },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(GRACE_DAYS) } },
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

  it('counts subscriptions due for renewal grouped by tenant (pre-existing behavior, unchanged)', async () => {
    primeEmptyExcept({ 0: [{ tenant: { id: 't1' } }, { tenant: { id: 't1' } }, { tenant: { id: 't2' } }] });
    const result = await processor.process({} as any);
    expect(result.due).toBe(3);
    expect(result.tenants).toBe(2);
  });

  it('returns zero when nothing is due', async () => {
    primeEmptyExcept({});
    const result = await processor.process({} as any);
    expect(result.due).toBe(0);
    expect(result.tenants).toBe(0);
  });

  it('pages through a full page followed by a partial page (L8)', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ tenant: { id: `t${i % 3}` } }));
    const lastPage = [{ tenant: { id: 't0' } }, { tenant: { id: 't3' } }];
    primeEmptyExcept({ 0: fullPage, 1: lastPage });

    const result = await processor.process({} as any);

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

      const result = await processor.process({} as any);

      expect(subscriptions.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SubscriptionStatus.PAST_DUE, grace_started_at: expect.any(Date) }),
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
        expect.objectContaining({ to: 'clinic@example.test', event: 'entered_grace', tenantId: 'tenant-1' }),
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

      const result = await processor.process({} as any);

      expect(subscriptions.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SubscriptionStatus.GRACE_EXPIRED, grace_expired_at: expect.any(Date) }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_GRACE_EXPIRED, entityId: 'sub-2' }),
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

      const result = await processor.process({} as any);

      expect(email.sendSubscriptionNotification).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'expiring_soon', to: 'clinic@example.test' }),
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

      const result = await processor.process({} as any);

      expect(email.sendSubscriptionNotification).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'grace_ending_soon', to: 'clinic@example.test' }),
      );
      expect(result.graceEndingSoonWarned).toBe(1);
    });

    it('notifies platform operators in addition to the tenant', async () => {
      (qb.getRawMany as jest.Mock).mockResolvedValueOnce([{ email: 'admin@platform.test' }]);
      const sub = {
        id: 'sub-5',
        status: SubscriptionStatus.ACTIVE,
        ends_at: new Date(Date.now() - 86_400_000),
        tenant: TENANT,
        plan: {},
      };
      primeEmptyExcept({ 2: [sub] });

      await processor.process({} as any);

      const recipients = (email.sendSubscriptionNotification as jest.Mock).mock.calls.map((c) => c[0].to);
      expect(recipients).toEqual(expect.arrayContaining(['clinic@example.test', 'admin@platform.test']));
    });

    // FR-B007 — no automatic re-billing anywhere in this flow.
    it('never calls anything resembling a charge/invoice on any transition', async () => {
      const sub = {
        id: 'sub-6',
        status: SubscriptionStatus.ACTIVE,
        ends_at: new Date(Date.now() - 86_400_000),
        tenant: TENANT,
        plan: {},
      };
      primeEmptyExcept({ 2: [sub] });
      await processor.process({} as any);
      // The only DI surface capable of billing (BillingService) was never
      // even injected into this processor — structurally impossible, not
      // just untested.
      expect(Object.getOwnPropertyNames(processor)).not.toContain('billing');
    });
  });
});
