import { SalesSelfService } from './sales-self.service';

/**
 * The rep's own view is the admin read model with admin-only fields removed.
 * These tests feed the facade admin-shaped objects that carry EVERY sensitive
 * field and assert none survives, and that the id always comes from the caller.
 * Real-Postgres behaviour (isolation between two reps, 403s) is proven by
 * `test/platform-sales-self.e2e-spec.ts`.
 */

const ME = 'rep-1';

const record = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  targetId: 't1',
  period: '2026-08',
  metric: 'new_clinics',
  targetValue: 10,
  achievedValue: 12,
  achievementPct: 120,
  rule: { type: 'fixed', secret: true },
  amount: 500,
  currency: 'USD',
  status: 'approved',
  computedAt: '2026-09-01T00:00:00Z',
  approvedBy: { id: 'admin', name: 'Admin Person' },
  approvedAt: '2026-09-01T00:00:00Z',
  paidMarkedBy: { id: 'admin', name: 'Admin Person' },
  paidMarkedAt: null,
  voidReason: 'typo',
  voidedBy: { id: 'admin', name: 'Admin Person' },
  voidedAt: null,
  ...over,
});

function build() {
  const employees = {
    requireEmployee: jest.fn().mockResolvedValue({ id: ME }),
    detail: jest.fn().mockResolvedValue({
      id: ME,
      email: 'rep@x.com',
      fullName: 'Rep',
      phone: null,
      isActive: true,
      roles: ['platform_sales'],
      lastLoginAt: new Date(),
      invitationStatus: 'active',
      createdAt: new Date(),
      assignedCount: 3,
      endedCount: 9,
      lastActivityAt: null,
      targets: [],
      bonusPreview: [],
    }),
  };
  const assignments = {
    listEmployeeClinics: jest.fn().mockResolvedValue({
      data: [
        {
          assignmentId: 'a1',
          clinic: { id: 'c1', name: 'Clinic', contactEmail: 'c@x.com', contactPhone: '+1' },
          kind: 'acquired',
          assignedAt: null,
          endedAt: null,
          endReason: null,
          note: 'PRIVATE admin note',
          lastActivityAt: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    }),
  };
  const targets = {
    list: jest.fn().mockResolvedValue({
      employeeId: ME,
      from: '2026-09',
      to: '2026-09',
      defaultCurrency: 'USD',
      currencies: ['USD'],
      billingLive: false,
      months: [
        {
          period: '2026-09',
          phase: 'current',
          metrics: [
            {
              employeeId: ME,
              metric: 'new_clinics',
              period: '2026-09',
              targetId: 't1',
              version: 4,
              target: 10,
              currency: null,
              achieved: 2,
              remaining: 8,
              percentage: 20,
              isCompleted: false,
              expectedPercentage: 30,
              onTrack: false,
              bonusRule: null,
              locked: false,
              excludedCurrencies: [],
              updatedAt: null,
            },
          ],
        },
      ],
    }),
  };
  const bonuses = {
    preview: jest.fn().mockResolvedValue({
      employeeId: ME,
      period: '2026-08',
      phase: 'past',
      billingLive: true,
      items: [
        {
          metric: 'new_clinics',
          period: '2026-08',
          targetId: 't1',
          version: 4,
          target: 10,
          achieved: 12,
          percentage: 120,
          currency: null,
          rule: { type: 'fixed' },
          applicable: true,
          thresholdMet: true,
          amount: 500,
          bonusCurrency: 'USD',
          excludedCurrencies: [],
          state: 'approved',
          record: record(),
          voidedCount: 2,
        },
        {
          metric: 'paid_conversions',
          period: '2026-08',
          targetId: 't2',
          version: 1,
          target: 5,
          achieved: 1,
          percentage: 20,
          currency: null,
          rule: null,
          applicable: false,
          thresholdMet: false,
          amount: 0,
          bonusCurrency: null,
          excludedCurrencies: [],
          state: 'ready',
          record: record({ status: 'void' }),
          voidedCount: 1,
        },
      ],
    }),
    list: jest.fn().mockResolvedValue({
      data: [record(), record({ id: 'b2', status: 'paid', paidMarkedAt: '2026-09-02T00:00:00Z' })],
      total: 2,
      page: 1,
      limit: 20,
      totals: { owed: [{ currency: 'USD', amount: 500 }], paid: [] },
    }),
  };
  const activities = {
    list: jest.fn().mockResolvedValue({
      data: [
        {
          id: 'x1',
          type: 'visit',
          occurredAt: null,
          clinic: null,
          prospectName: 'P',
          outcome: null,
          note: null,
          source: 'admin_manual',
          recordedBy: { id: 'admin', name: 'Admin Person' },
          createdAt: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    }),
    create: jest.fn().mockResolvedValue({
      id: 'x2',
      type: 'visit',
      source: 'self',
      recordedBy: { id: ME, name: 'Rep' },
    }),
  };
  const service = new SalesSelfService(
    employees as any,
    assignments as any,
    targets as any,
    bonuses as any,
    activities as any,
  );
  return { service, employees, assignments, targets, bonuses, activities };
}

const text = (v: unknown) => JSON.stringify(v);

describe('SalesSelfService', () => {
  it('profile exposes the rep’s own figures and none of the staff/admin fields', async () => {
    const { service } = build();
    const p = await service.profile(ME, '2026-09');
    expect(p).toMatchObject({ id: ME, assignedCount: 3, period: '2026-09' });
    for (const hidden of ['roles', 'invitationStatus', 'lastLoginAt', 'createdAt', 'endedCount', 'isActive']) {
      expect(p).not.toHaveProperty(hidden);
    }
  });

  it('every read is for the caller and demands an ACTIVE employee', async () => {
    const t = build();
    await t.service.profile(ME);
    await t.service.clinics(ME, {} as any);
    await t.service.targetsFor(ME, {} as any);
    await t.service.bonusPreview(ME, {} as any);
    await t.service.bonusRecords(ME, {} as any);
    await t.service.activityList(ME, {} as any);
    for (const call of t.employees.requireEmployee.mock.calls) {
      expect(call).toEqual([ME, { requireActive: true }]);
    }
    expect(t.employees.detail).toHaveBeenCalledWith(ME, undefined);
    expect(t.assignments.listEmployeeClinics.mock.calls[0][0]).toBe(ME);
    expect(t.targets.list.mock.calls[0][0]).toBe(ME);
    expect(t.bonuses.preview.mock.calls[0][0]).toBe(ME);
    expect(t.bonuses.list.mock.calls[0][0]).toBe(ME);
    expect(t.activities.list.mock.calls[0][0]).toBe(ME);
  });

  it('clinics keep the contact details but never the admin assignment note', async () => {
    const { service } = build();
    const page = await service.clinics(ME, {} as any);
    expect(page.data[0].clinic).toMatchObject({ contactEmail: 'c@x.com', contactPhone: '+1' });
    expect(text(page)).not.toContain('PRIVATE');
    expect(page.data[0]).not.toHaveProperty('note');
  });

  it('targets drop ids, version and the currency catalogue', async () => {
    const { service } = build();
    const t = await service.targetsFor(ME, {} as any);
    const m = t.months[0].metrics[0];
    expect(m).toMatchObject({ metric: 'new_clinics', target: 10, achieved: 2 });
    for (const hidden of ['employeeId', 'targetId', 'version']) expect(m).not.toHaveProperty(hidden);
    expect(t).not.toHaveProperty('currencies');
    expect(t).not.toHaveProperty('employeeId');
  });

  it('bonus preview hides admin names, rule snapshot, void reason and voided records', async () => {
    const { service } = build();
    const m = await service.bonusPreview(ME, {} as any);
    expect(m.items[0].record).toMatchObject({ id: 'b1', amount: 500, status: 'approved' });
    expect(m.items[1].record).toBeNull(); // a voided record is not shown
    const s = text(m);
    for (const leak of ['Admin Person', 'typo', 'secret', 'voidReason', 'approvedBy', 'voidedBy', 'paidMarkedBy', 'voidedCount', 'targetId']) {
      expect(s).not.toContain(leak);
    }
  });

  it('bonus records exclude voided ones at the query and strip admin fields', async () => {
    const t = build();
    const list = await t.service.bonusRecords(ME, {} as any);
    expect(t.bonuses.list).toHaveBeenCalledWith(ME, {}, { excludeVoid: true });
    expect(list.totals.owed).toEqual([{ currency: 'USD', amount: 500 }]);
    const s = text(list);
    for (const leak of ['Admin Person', 'typo', 'secret', 'approvedBy', 'voidedBy']) {
      expect(s).not.toContain(leak);
    }
    expect(list.data.map((r) => r.status)).toEqual(['approved', 'paid']);
  });

  it('activities hide the admin who recorded them; logging passes source self and the rep as actor', async () => {
    const t = build();
    const page = await t.service.activityList(ME, {} as any);
    expect(page.data[0]).not.toHaveProperty('recordedBy');
    expect(text(page)).not.toContain('Admin Person');

    const dto = { type: 'visit', prospectName: 'P', occurredAt: 'x' } as any;
    const created = await t.service.logActivity(ME, dto);
    expect(t.activities.create).toHaveBeenCalledWith(ME, dto, ME, { source: 'self' });
    expect(created).not.toHaveProperty('recordedBy');
  });
});
