import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ScheduledPlanChangeService } from './scheduled-plan-change.service';
import { AccessControlService } from './access-control.service';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionStatus } from '../../entities/enums';
import { SubscriptionPlanChangedEvent } from '../../events/subscription.events';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('ScheduledPlanChangeService', () => {
  let service: ScheduledPlanChangeService;
  let subscriptions: MockRepository;
  let qb: MockQueryBuilder;
  let access: { invalidate: jest.Mock };
  let audit: { record: jest.Mock };
  let emitter: { emit: jest.Mock };

  const NOW = new Date('2026-11-01T02:00:00.000Z');
  const ENDS = new Date('2026-10-31T18:00:00.000Z');

  const due = (over: Record<string, unknown> = {}) => ({
    id: 'sub1',
    tenant: { id: 't1' },
    plan: { id: 'p-pro' },
    pending_plan: { id: 'p-lite' },
    ends_at: ENDS,
    ...over,
  });

  beforeEach(async () => {
    subscriptions = createMockRepository();
    qb = createMockQueryBuilder();
    subscriptions.createQueryBuilder.mockReturnValue(qb);
    access = { invalidate: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledPlanChangeService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptions },
        { provide: AccessControlService, useValue: access },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = moduleRef.get(ScheduledPlanChangeService);
  });

  afterEach(() => jest.clearAllMocks());

  it('selects only non-renewing, non-terminal subscriptions whose term has ended with a downgrade scheduled', async () => {
    subscriptions.find.mockResolvedValueOnce([]);
    await service.applyDueDowngrades(NOW);
    const where = subscriptions.find.mock.calls[0][0].where;
    expect(where.auto_renew).toBe(false);
    expect(where.ends_at).toMatchObject({
      _type: 'lessThanOrEqual',
      _value: NOW,
    });
    expect(where.status._value).toEqual([
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIAL,
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.GRACE_EXPIRED,
    ]);
    expect(where.status._value).not.toContain(SubscriptionStatus.CANCELLED);
    expect(where.status._value).not.toContain(SubscriptionStatus.SUSPENDED);
    expect(where.pending_plan).toBeDefined();
  });

  it('applies the downgrade with ONE guarded UPDATE: plan := pending, pending := NULL, the paid-through date untouched', async () => {
    subscriptions.find.mockResolvedValueOnce([due()]);

    const res = await service.applyDueDowngrades(NOW);

    expect(res).toEqual({ scanned: 1, applied: 1, skipped: 0 });
    const set = (qb.set as jest.Mock).mock.calls[0][0];
    expect(set.plan()).toBe('"pending_plan_id"');
    expect(set.pending_plan).toBeNull();
    // Nothing about the period, the status or billing is written.
    expect(Object.keys(set).sort()).toEqual(['pending_plan', 'plan']);
    expect(qb.where).toHaveBeenCalledWith('id = :id', { id: 'sub1' });
    expect(qb.andWhere).toHaveBeenCalledWith('pending_plan_id = :toPlanId', {
      toPlanId: 'p-lite',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('auto_renew = false');
    expect(qb.andWhere).toHaveBeenCalledWith('ends_at <= :now', { now: NOW });
    expect(subscriptions.save).not.toHaveBeenCalled();

    expect(access.invalidate).toHaveBeenCalledWith('t1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action:
          PLATFORM_ADMIN_AUDIT_ACTION.SUBSCRIPTION_SCHEDULED_DOWNGRADE_APPLIED,
        userId: undefined,
        entityId: 'sub1',
        tenantId: 't1',
        before: { planId: 'p-pro', pendingPlanId: 'p-lite' },
        after: {
          planId: 'p-lite',
          pendingPlanId: null,
          paidThrough: ENDS.toISOString(),
        },
      }),
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      SubscriptionPlanChangedEvent.eventName,
      expect.objectContaining({ tenantId: 't1', newPlanId: 'p-lite' }),
    );
  });

  it('a duplicate / retried run (the row was already applied, or auto-renew came back on) changes nothing and emits nothing', async () => {
    subscriptions.find.mockResolvedValueOnce([due()]);
    (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 0, raw: [] });

    const res = await service.applyDueDowngrades(NOW);

    expect(res).toEqual({ scanned: 1, applied: 0, skipped: 1 });
    expect(audit.record).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(access.invalidate).not.toHaveBeenCalled();
  });

  it('two overlapping sweeps apply it exactly once (the database decides)', async () => {
    subscriptions.find.mockResolvedValue([due()]);
    let applied = false;
    (qb.execute as jest.Mock).mockImplementation(async () => {
      const affected = applied ? 0 : 1;
      applied = true;
      return { affected, raw: [] };
    });

    const [a, b] = await Promise.all([
      service.applyDueDowngrades(NOW),
      service.applyDueDowngrades(NOW),
    ]);

    expect(a.applied + b.applied).toBe(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledTimes(1);
  });

  it('one failing row does not stop the rest of the page', async () => {
    subscriptions.find.mockResolvedValueOnce([
      due({ id: 'bad' }),
      due({ id: 'good' }),
    ]);
    (qb.execute as jest.Mock)
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ affected: 1, raw: [] });

    const res = await service.applyDueDowngrades(NOW);

    expect(res).toEqual({ scanned: 2, applied: 1, skipped: 1 });
  });

  it('pages by id (keyset), so skipped rows are not re-read forever', async () => {
    const full = Array.from({ length: 200 }, (_, i) =>
      due({ id: `s${String(i).padStart(3, '0')}` }),
    );
    subscriptions.find
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([due({ id: 's999' })]);

    await service.applyDueDowngrades(NOW);

    expect(subscriptions.find).toHaveBeenCalledTimes(2);
    const second = subscriptions.find.mock.calls[1][0].where;
    expect(second.id).toMatchObject({ _type: 'moreThan', _value: 's199' });
  });
});
