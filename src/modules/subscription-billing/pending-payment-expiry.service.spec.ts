import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { PendingPaymentExpiryService } from './pending-payment-expiry.service';
import { BillingService } from './billing.service';
import { AccessControlService } from './access-control.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionInvoice } from '../../entities/SaaS-Core/SubscriptionInvoice';
import { InvoiceStatus, SubscriptionStatus } from '../../entities/enums';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import {
  createMockDataSource,
  createMockEntityManager,
  createMockRepository,
  MockDataSource,
  MockEntityManager,
  MockRepository,
} from '../../../test/utils/mock-factories';

const DAY = 86_400_000;
const NOW = new Date('2026-10-18T12:00:00.000Z');

describe('PendingPaymentExpiryService', () => {
  let service: PendingPaymentExpiryService;
  let subscriptions: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let billing: { isPaymentInFlight: jest.Mock };
  let access: { invalidate: jest.Mock };
  let audit: { record: jest.Mock };
  let ttl: number | undefined;

  const invRepo = () =>
    manager.getRepository(SubscriptionInvoice) as unknown as MockRepository;
  const subRepo = () =>
    manager.getRepository(Subscription) as unknown as MockRepository;

  const pageRow = (id = 'sub-1') => ({ id, tenant: { id: 't1' } });
  const lockedSub = (over: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    status: SubscriptionStatus.PENDING_PAYMENT,
    auto_renew: true,
    pending_plan: { id: 'p' } as unknown,
    deleted_at: null,
    updated_at: new Date(NOW.getTime() - 9 * DAY),
    ...over,
  });
  const unpaid = (over: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    status: InvoiceStatus.OPEN,
    charge_started_at: null as Date | null,
    next_retry_at: null as Date | null,
    ...over,
  });

  beforeEach(async () => {
    ttl = undefined;
    subscriptions = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    billing = { isPaymentInFlight: jest.fn().mockReturnValue(false) };
    access = { invalidate: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PendingPaymentExpiryService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: DataSource, useValue: dataSource },
        { provide: BillingService, useValue: billing },
        { provide: AccessControlService, useValue: access },
        { provide: PlatformAdminAuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_k: string, d: unknown) =>
              ttl === undefined ? d : ttl,
            ),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(PendingPaymentExpiryService);
  });

  afterEach(() => jest.clearAllMocks());

  it('defaults to 7 days', () => {
    expect(service.ttlDays()).toBe(7);
  });

  it('a TTL of 0 switches the sweep off — nothing is even read', async () => {
    ttl = 0;
    const summary = await service.expireAbandoned(NOW);
    expect(summary).toMatchObject({ disabled: true, scanned: 0, cancelled: 0 });
    expect(subscriptions.find).not.toHaveBeenCalled();
  });

  it('looks only at PENDING_PAYMENT, not deleted, untouched for the whole TTL', async () => {
    subscriptions.find.mockResolvedValueOnce([]);
    await service.expireAbandoned(NOW);
    const where = subscriptions.find.mock.calls[0][0].where;
    expect(where.status).toBe(SubscriptionStatus.PENDING_PAYMENT);
    expect(where.deleted_at).toBeDefined();
    // "untouched for 7 days": the cutoff is exactly NOW - 7d
    expect(where.updated_at.value ?? where.updated_at._value).toEqual(
      new Date(NOW.getTime() - 7 * DAY),
    );
  });

  it('cancels an abandoned subscription, voids its unpaid invoices, stops auto-renew, drops a scheduled plan, and audits', async () => {
    subscriptions.find.mockResolvedValueOnce([pageRow()]);
    const sub = lockedSub();
    const inv = unpaid({ charge_started_at: new Date('2026-10-01') });
    invRepo().find.mockResolvedValueOnce([inv]);
    subRepo().findOne.mockResolvedValueOnce(sub);

    const summary = await service.expireAbandoned(NOW);

    expect(summary).toMatchObject({ scanned: 1, cancelled: 1, skipped: 0 });
    expect(sub).toMatchObject({
      status: SubscriptionStatus.CANCELLED,
      auto_renew: false,
      pending_plan: null,
    });
    expect(inv).toMatchObject({
      status: InvoiceStatus.VOID,
      charge_started_at: null,
      next_retry_at: null,
    });
    expect(subRepo().save).toHaveBeenCalledWith(sub);
    expect(access.invalidate).toHaveBeenCalledWith('t1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action:
          PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_PENDING_PAYMENT_EXPIRED,
        entityId: 'sub-1',
        tenantId: 't1',
        after: expect.objectContaining({
          voidedInvoiceIds: ['inv-1'],
          ttlDays: 7,
        }),
      }),
    );
  });

  it('locks the invoices BEFORE the subscription — the order a settlement uses, so the two can never deadlock', async () => {
    subscriptions.find.mockResolvedValueOnce([pageRow()]);
    invRepo().find.mockResolvedValueOnce([unpaid()]);
    subRepo().findOne.mockResolvedValueOnce(lockedSub());
    await service.expireAbandoned(NOW);

    expect(invRepo().find.mock.calls[0][0].lock).toEqual({
      mode: 'pessimistic_write',
    });
    expect(subRepo().findOne.mock.calls[0][0].lock).toEqual({
      mode: 'pessimistic_write',
    });
    expect(invRepo().find.mock.invocationCallOrder[0]).toBeLessThan(
      subRepo().findOne.mock.invocationCallOrder[0],
    );
    // a locked read must not carry a join (Postgres refuses FOR UPDATE over an outer join)
    expect(invRepo().find.mock.calls[0][0].relations).toBeUndefined();
    expect(subRepo().findOne.mock.calls[0][0].relations).toBeUndefined();
  });

  it('a subscription with no unpaid invoice at all is still cancelled', async () => {
    subscriptions.find.mockResolvedValueOnce([pageRow()]);
    invRepo().find.mockResolvedValueOnce([]);
    subRepo().findOne.mockResolvedValueOnce(lockedSub());
    const summary = await service.expireAbandoned(NOW);
    expect(summary.cancelled).toBe(1);
    expect(invRepo().save).not.toHaveBeenCalled();
  });

  it('SKIPS a subscription whose invoice may still be paid (open checkout / unresolved charge) — nothing is changed', async () => {
    subscriptions.find.mockResolvedValueOnce([pageRow()]);
    const sub = lockedSub();
    const inv = unpaid();
    invRepo().find.mockResolvedValueOnce([inv]);
    subRepo().findOne.mockResolvedValueOnce(sub);
    billing.isPaymentInFlight.mockReturnValueOnce(true);

    const summary = await service.expireAbandoned(NOW);

    expect(summary).toMatchObject({ scanned: 1, cancelled: 0, skipped: 1 });
    expect(sub.status).toBe(SubscriptionStatus.PENDING_PAYMENT);
    expect(inv.status).toBe(InvoiceStatus.OPEN);
    expect(subRepo().save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(access.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['it was paid meanwhile (ACTIVE)', { status: SubscriptionStatus.ACTIVE }],
    ['it was already cancelled', { status: SubscriptionStatus.CANCELLED }],
    ['it was soft-deleted', { deleted_at: new Date() }],
    [
      'the clinic touched it again (fresh updated_at)',
      { updated_at: new Date(NOW.getTime() - DAY) },
    ],
  ])('re-checks under the lock and SKIPS when %s', async (_l, over) => {
    subscriptions.find.mockResolvedValueOnce([pageRow()]);
    const sub = lockedSub(over);
    const before = { ...sub };
    invRepo().find.mockResolvedValueOnce([unpaid()]);
    subRepo().findOne.mockResolvedValueOnce(sub);

    const summary = await service.expireAbandoned(NOW);

    expect(summary).toMatchObject({ cancelled: 0, skipped: 1 });
    expect(sub).toEqual(before);
    expect(subRepo().save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a subscription that vanished between the page and the lock is skipped', async () => {
    subscriptions.find.mockResolvedValueOnce([pageRow()]);
    invRepo().find.mockResolvedValueOnce([]);
    subRepo().findOne.mockResolvedValueOnce(null);
    expect((await service.expireAbandoned(NOW)).skipped).toBe(1);
  });

  it('one failing subscription does not stop the sweep', async () => {
    subscriptions.find.mockResolvedValueOnce([
      pageRow('sub-1'),
      pageRow('sub-2'),
    ]);
    invRepo()
      .find.mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce([unpaid({ id: 'inv-2' })]);
    subRepo().findOne.mockResolvedValueOnce(lockedSub({ id: 'sub-2' }));

    const summary = await service.expireAbandoned(NOW);

    expect(summary).toMatchObject({ scanned: 2, cancelled: 1, skipped: 1 });
  });

  it('pages by id (keyset), so rows that are skipped are not re-read forever', async () => {
    const full = Array.from({ length: 200 }, (_, i) =>
      pageRow(`sub-${String(i).padStart(3, '0')}`),
    );
    subscriptions.find
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([pageRow('sub-999')]);
    invRepo().find.mockResolvedValue([]);
    subRepo().findOne.mockResolvedValue(null); // all skipped

    const summary = await service.expireAbandoned(NOW);

    expect(summary.scanned).toBe(201);
    expect(subscriptions.find).toHaveBeenCalledTimes(2);
    const second = subscriptions.find.mock.calls[1][0].where.id;
    expect(second).toBeDefined(); // MoreThan(lastId of page 1)
  });
});
