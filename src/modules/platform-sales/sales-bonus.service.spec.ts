import { ErrorCode } from '../../common/errors';
import { PLATFORM_ADMIN_AUDIT_ACTION } from '../platform/platform-admin-audit.service';
import { SalesBonusService } from './sales-bonus.service';

/**
 * Unit tests of the bonus rules. The transaction is a pass-through and every
 * statement is recorded, so these prove WHICH statements run (or do not) for
 * each rule. Locking, the unique key and the attribution are proven on a real
 * Postgres by `test/platform-sales-bonuses.e2e-spec.ts`.
 */

const NOW = new Date();
const CURRENT = `${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, '0')}`;
const PAST = '2020-03';

const lockedTarget = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  salesUserId: 'e1',
  period: PAST,
  metric: 'new_clinics',
  targetValue: 4,
  currency: null,
  bonusType: 'fixed_on_threshold',
  bonusThresholdPct: 100,
  bonusAmount: 500,
  bonusPercent: null,
  bonusCurrency: 'SAR',
  version: 2,
  updatedAt: null,
  locked: false,
  ...over,
});

const progressRow = (over: Record<string, unknown> = {}) => ({
  employeeId: 'e1',
  metric: 'new_clinics',
  period: PAST,
  targetId: 't1',
  version: 2,
  target: 4,
  currency: null,
  achieved: 4,
  remaining: 0,
  percentage: 100,
  isCompleted: true,
  expectedPercentage: 100,
  onTrack: true,
  bonusRule: { type: 'fixed_on_threshold', thresholdPct: 100, amount: 500, percent: null, currency: 'SAR' },
  locked: false,
  excludedCurrencies: [],
  updatedAt: null,
  ...over,
});

const recordRow = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  target_id: 't1',
  period: PAST,
  metric: 'new_clinics',
  target_value: '4.00',
  achieved_value: '4.00',
  achievement_pct: '100.00',
  rule_snapshot: { type: 'fixed_on_threshold' },
  bonus_amount: '500.00',
  currency: 'SAR',
  status: 'approved',
  computed_at: NOW,
  approved_by: 'admin',
  approved_by_name: 'Admin',
  approved_at: NOW,
  paid_marked_by: null,
  paid_marked_by_name: null,
  paid_marked_at: null,
  void_reason: null,
  voided_by: null,
  voided_by_name: null,
  voided_at: null,
  ...over,
});

function build() {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const state = {
    insertError: null as unknown,
    updateRows: [] as unknown[],
    selectStatus: [] as unknown[],
    voidLock: [] as unknown[],
    recordRows: [recordRow()] as unknown[],
    previewRecords: [] as unknown[],
    totals: [] as unknown[],
  };
  const route = async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (/INSERT INTO sales_bonus_records/.test(sql)) {
      if (state.insertError) throw state.insertError;
      return [{ id: 'b1' }];
    }
    if (/^\s*UPDATE sales_bonus_records/.test(sql)) return [state.updateRows, state.updateRows.length];
    if (/SELECT status FROM sales_bonus_records/.test(sql)) return state.selectStatus;
    if (/FOR UPDATE/.test(sql)) return state.voidLock;
    if (/SUM\(bonus_amount\)/.test(sql)) return state.totals;
    if (/COUNT\(\*\)/.test(sql)) return [{ total: state.recordRows.length }];
    if (/WHERE b\.target_id = ANY/.test(sql)) return state.previewRecords;
    if (/FROM sales_bonus_records b/.test(sql)) return state.recordRows;
    return [];
  };
  const manager = { query: jest.fn(route) };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)),
    query: jest.fn(route),
  } as any;
  const employees = { requireEmployee: jest.fn().mockResolvedValue({ id: 'e1' }) } as any;
  const targets = { lockTarget: jest.fn().mockResolvedValue(lockedTarget()) } as any;
  const progress = {
    defaultCurrency: jest.fn().mockResolvedValue('SAR'),
    rows: jest.fn().mockResolvedValue([progressRow()]),
  } as any;
  const billing = { get: jest.fn().mockResolvedValue('FREE') } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const service = new SalesBonusService(dataSource, employees, targets, progress, billing, audit);
  return {
    service,
    statements,
    state,
    manager,
    dataSource,
    employees,
    targets,
    progress,
    audit,
    has: (re: RegExp) => statements.some((s) => re.test(s.sql)),
  };
}

const rejects = async (p: Promise<unknown>, code: ErrorCode) =>
  expect(p).rejects.toMatchObject({ code });

describe('SalesBonusService.approve', () => {
  it('refuses a month that has not closed yet, and writes nothing', async () => {
    const t = build();
    await rejects(
      t.service.approve('e1', CURRENT, 'new_clinics', {}, 'admin'),
      ErrorCode.SALES_PERIOD_NOT_CLOSED,
    );
    expect(t.has(/INSERT INTO sales_bonus_records/)).toBe(false);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('a target that does not exist is a 404', async () => {
    const t = build();
    t.targets.lockTarget.mockResolvedValue(null);
    await rejects(
      t.service.approve('e1', PAST, 'new_clinics', {}, 'admin'),
      ErrorCode.SALES_TARGET_NOT_FOUND,
    );
  });

  it('a target that already has a live bonus cannot be approved again', async () => {
    const t = build();
    t.targets.lockTarget.mockResolvedValue(lockedTarget({ locked: true }));
    await rejects(
      t.service.approve('e1', PAST, 'new_clinics', {}, 'admin'),
      ErrorCode.SALES_BONUS_EXISTS,
    );
    expect(t.has(/INSERT INTO sales_bonus_records/)).toBe(false);
  });

  it('a rule edited since the admin looked (expectedVersion) is a conflict, not an approval', async () => {
    const t = build();
    await rejects(
      t.service.approve('e1', PAST, 'new_clinics', { expectedVersion: 1 }, 'admin'),
      ErrorCode.SALES_TARGET_VERSION_CONFLICT,
    );
    expect(t.has(/INSERT INTO sales_bonus_records/)).toBe(false);
  });

  it('a target without a bonus rule has nothing to approve', async () => {
    const t = build();
    t.targets.lockTarget.mockResolvedValue(lockedTarget({ bonusType: 'none', bonusThresholdPct: null, bonusAmount: null }));
    await rejects(
      t.service.approve('e1', PAST, 'new_clinics', {}, 'admin'),
      ErrorCode.SALES_BONUS_NO_RULE,
    );
  });

  it('computes the amount from the LOCKED rule and the recomputed progress, on the transaction connection', async () => {
    const t = build();
    await t.service.approve('e1', PAST, 'new_clinics', { expectedVersion: 2 }, 'admin');

    const insert = t.statements.find((s) => /INSERT INTO sales_bonus_records/.test(s.sql))!;
    const p = insert.params!;
    expect(p[0]).toBe('t1'); //   target
    expect(p[1]).toBe('e1'); //   employee
    expect(p[3]).toBe('new_clinics');
    expect(p[4]).toBe(4); //      target value (from the locked row)
    expect(p[5]).toBe(4); //      achieved (recomputed)
    expect(p[6]).toBe(100); //    achievement %
    expect(JSON.parse(p[7] as string)).toMatchObject({ type: 'fixed_on_threshold', thresholdMet: true });
    expect(p[8]).toBe(500); //    amount decided by computeBonus
    expect(p[9]).toBe('SAR');
    expect(p[10]).toBe('admin');

    // Progress is read through the SAME connection that holds the row lock.
    expect(t.progress.rows.mock.calls[0][0].manager).toBe(t.manager);
    expect(t.targets.lockTarget.mock.calls[0][0]).toBe(t.manager);
    expect(t.employees.requireEmployee.mock.calls[0][1].manager).toBe(t.manager);
  });

  it('pays nothing when the threshold was missed, but still records the decision', async () => {
    const t = build();
    t.progress.rows.mockResolvedValue([progressRow({ achieved: 3, percentage: 75, isCompleted: false })]);
    await t.service.approve('e1', PAST, 'new_clinics', {}, 'admin');
    const p = t.statements.find((s) => /INSERT INTO sales_bonus_records/.test(s.sql))!.params!;
    expect(p[8]).toBe(0);
    expect(JSON.parse(p[7] as string)).toMatchObject({ thresholdMet: false });
  });

  it('a percentage bonus takes its share of the achieved revenue', async () => {
    const t = build();
    t.targets.lockTarget.mockResolvedValue(
      lockedTarget({
        metric: 'subscription_revenue',
        currency: 'SAR',
        targetValue: 1000,
        bonusType: 'percent_of_achieved',
        bonusThresholdPct: null,
        bonusAmount: null,
        bonusPercent: 5,
        bonusCurrency: 'SAR',
      }),
    );
    t.progress.rows.mockResolvedValue([
      progressRow({ metric: 'subscription_revenue', currency: 'SAR', target: 1000, achieved: 1500, percentage: 150 }),
    ]);
    await t.service.approve('e1', PAST, 'subscription_revenue', {}, 'admin');
    const p = t.statements.find((s) => /INSERT INTO sales_bonus_records/.test(s.sql))!.params!;
    expect(p[8]).toBe(75);
  });

  it('writes one audit entry with the frozen figures, after the transaction', async () => {
    const t = build();
    await t.service.approve('e1', PAST, 'new_clinics', {}, 'admin');
    expect(t.audit.record).toHaveBeenCalledTimes(1);
    const call = t.audit.record.mock.calls[0][0];
    expect(call.action).toBe(PLATFORM_ADMIN_AUDIT_ACTION.SALES_BONUS_APPROVED);
    expect(call.entityId).toBe('b1');
    expect(call.after).toMatchObject({ employeeId: 'e1', period: PAST, metric: 'new_clinics', amount: 500, currency: 'SAR' });
  });

  it('a unique-key violation (a racing approval) surfaces as SALES_BONUS_EXISTS', async () => {
    const t = build();
    t.state.insertError = Object.assign(new Error('duplicate'), { code: '23505' });
    await rejects(
      t.service.approve('e1', PAST, 'new_clinics', {}, 'admin'),
      ErrorCode.SALES_BONUS_EXISTS,
    );
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('a deactivated employee can still be approved — requireActive is not asked for', async () => {
    const t = build();
    await t.service.approve('e1', PAST, 'new_clinics', {}, 'admin');
    expect(t.employees.requireEmployee.mock.calls[0][1].requireActive).toBeUndefined();
  });
});

describe('SalesBonusService.markPaid', () => {
  it('moves approved → paid with a conditional update, and audits it', async () => {
    const t = build();
    t.state.updateRows = [{ id: 'b1', bonus_amount: '500.00', currency: 'SAR', period: PAST, metric: 'new_clinics' }];
    await t.service.markPaid('e1', 'b1', 'admin');
    const upd = t.statements.find((s) => /^\s*UPDATE sales_bonus_records/.test(s.sql))!;
    expect(upd.sql).toMatch(/status = 'approved'/);
    expect(upd.sql).toMatch(/sales_user_id = \$2/);
    expect(upd.params).toEqual(['b1', 'e1', 'admin']);
    expect(t.audit.record.mock.calls[0][0]).toMatchObject({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_BONUS_MARKED_PAID,
      before: { status: 'approved' },
      after: { status: 'paid', amount: 500 },
    });
  });

  it('a bonus that is not approved (already paid / void) is a 409 naming its status', async () => {
    const t = build();
    t.state.updateRows = [];
    t.state.selectStatus = [{ status: 'paid' }];
    await expect(t.service.markPaid('e1', 'b1', 'admin')).rejects.toMatchObject({
      code: ErrorCode.SALES_BONUS_STATE_CONFLICT,
    });
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it("another employee's bonus id is indistinguishable from a random one (404)", async () => {
    const t = build();
    t.state.updateRows = [];
    t.state.selectStatus = [];
    await rejects(t.service.markPaid('e1', 'b1', 'admin'), ErrorCode.SALES_BONUS_NOT_FOUND);
  });
});

describe('SalesBonusService.voidBonus', () => {
  const lockRow = (status: string) => [
    { id: 'b1', status, bonus_amount: '500.00', currency: 'SAR', period: PAST, metric: 'new_clinics' },
  ];

  it('needs a reason — before touching the database', async () => {
    const t = build();
    await rejects(t.service.voidBonus('e1', 'b1', { reason: '   ' }, 'admin'), ErrorCode.SALES_REASON_REQUIRED);
    await rejects(t.service.voidBonus('e1', 'b1', {}, 'admin'), ErrorCode.SALES_REASON_REQUIRED);
    expect(t.statements).toHaveLength(0);
  });

  it('voids an approved bonus under a row lock, storing the trimmed reason and who did it', async () => {
    const t = build();
    t.state.voidLock = lockRow('approved');
    await t.service.voidBonus('e1', 'b1', { reason: '  wrong figures  ' }, 'admin');
    expect(t.has(/FOR UPDATE/)).toBe(true);
    const upd = t.statements.find((s) => /^\s*UPDATE sales_bonus_records/.test(s.sql))!;
    expect(upd.params).toEqual(['b1', 'wrong figures', 'admin']);
    expect(t.audit.record.mock.calls[0][0]).toMatchObject({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_BONUS_VOIDED,
      before: { status: 'approved' },
      after: { status: 'void', reason: 'wrong figures', wasPaid: false },
    });
  });

  it('voiding a bonus that was marked paid is allowed and flagged in the audit trail', async () => {
    const t = build();
    t.state.voidLock = lockRow('paid');
    await t.service.voidBonus('e1', 'b1', { reason: 'paid by mistake' }, 'admin');
    expect(t.audit.record.mock.calls[0][0].after).toMatchObject({ wasPaid: true });
  });

  it('an already-void bonus is a 409, a missing one a 404', async () => {
    const t = build();
    t.state.voidLock = lockRow('void');
    await rejects(t.service.voidBonus('e1', 'b1', { reason: 'x' }, 'admin'), ErrorCode.SALES_BONUS_STATE_CONFLICT);
    t.state.voidLock = [];
    await rejects(t.service.voidBonus('e1', 'b1', { reason: 'x' }, 'admin'), ErrorCode.SALES_BONUS_NOT_FOUND);
    expect(t.audit.record).not.toHaveBeenCalled();
  });
});

describe('SalesBonusService.preview', () => {
  it('derives the state of each metric: open / ready / approved / paid / no_rule', async () => {
    const t = build();
    t.progress.rows.mockResolvedValue([
      progressRow({ metric: 'new_clinics', targetId: 't1' }),
      progressRow({ metric: 'subscription_revenue', targetId: 't2', currency: 'SAR', bonusRule: null }),
      progressRow({ metric: 'paid_conversions', targetId: 't3' }),
    ]);
    // t3 has a live approved record, t1 only a void one.
    t.state.previewRecords = [
      recordRow({ id: 'b3', target_id: 't3', status: 'approved' }),
      recordRow({ id: 'b1', target_id: 't1', status: 'void' }),
    ];
    const past = await t.service.preview('e1', PAST);
    const byMetric = Object.fromEntries(past.items.map((i) => [i.metric, i]));
    expect(byMetric.new_clinics).toMatchObject({ state: 'ready', voidedCount: 1, record: null });
    expect(byMetric.subscription_revenue.state).toBe('no_rule');
    expect(byMetric.paid_conversions).toMatchObject({ state: 'approved', record: { id: 'b3', amount: 500 } });

    t.state.previewRecords = [recordRow({ id: 'b3', target_id: 't3', status: 'paid' })];
    const open = await t.service.preview('e1', CURRENT);
    expect(open.phase).toBe('current');
    expect(open.items.find((i) => i.metric === 'new_clinics')!.state).toBe('open');
    expect(open.items.find((i) => i.metric === 'paid_conversions')!.state).toBe('paid');
  });

  it('projects what the rule pays for the progress so far, without any record', async () => {
    const t = build();
    t.progress.rows.mockResolvedValue([progressRow({ achieved: 3, percentage: 75, isCompleted: false })]);
    const m = await t.service.preview('e1', CURRENT);
    expect(m.items[0]).toMatchObject({ applicable: true, thresholdMet: false, amount: 0 });
    t.progress.rows.mockResolvedValue([progressRow({ achieved: 4 })]);
    const m2 = await t.service.preview('e1', CURRENT);
    expect(m2.items[0]).toMatchObject({ thresholdMet: true, amount: 500, bonusCurrency: 'SAR' });
  });

  it('reads the records of ALL the month\'s targets with ONE query', async () => {
    const t = build();
    t.progress.rows.mockResolvedValue([
      progressRow({ metric: 'new_clinics', targetId: 't1' }),
      progressRow({ metric: 'paid_conversions', targetId: 't3' }),
    ]);
    await t.service.preview('e1', PAST);
    expect(t.statements.filter((s) => /target_id = ANY/.test(s.sql))).toHaveLength(1);
  });

  it('a month with no targets issues no record query at all', async () => {
    const t = build();
    t.progress.rows.mockResolvedValue([]);
    const m = await t.service.preview('e1', PAST);
    expect(m.items).toEqual([]);
    expect(t.statements).toHaveLength(0);
  });
});

describe('SalesBonusService.list', () => {
  it('returns the page plus lifetime owed / paid totals per currency', async () => {
    const t = build();
    t.state.totals = [
      { status: 'approved', currency: 'SAR', amount: '700.50' },
      { status: 'paid', currency: 'SAR', amount: '300.00' },
      { status: 'paid', currency: 'USD', amount: '50.00' },
    ];
    const out = await t.service.list('e1', { page: 1, limit: 20, offset: () => 0 } as any);
    expect(out.total).toBe(1);
    expect(out.totals).toEqual({
      owed: [{ currency: 'SAR', amount: 700.5 }],
      paid: [
        { currency: 'SAR', amount: 300 },
        { currency: 'USD', amount: 50 },
      ],
    });
    expect(out.data[0]).toMatchObject({ id: 'b1', amount: 500, status: 'approved', approvedBy: { id: 'admin', name: 'Admin' } });
  });
});
