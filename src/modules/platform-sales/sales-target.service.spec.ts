import { ErrorCode } from '../../common/errors';
import { PLATFORM_ADMIN_AUDIT_ACTION } from '../platform/platform-admin-audit.service';
import { SalesTargetService } from './sales-target.service';

/**
 * Unit tests of the write rules. The transaction is a pass-through and the
 * statements are recorded, so these prove WHICH statements run (or do not) for
 * each rule; the real-Postgres behaviour (locks, unique keys, attribution) is
 * proven by `test/platform-sales.e2e-spec.ts`.
 */

const NOW = new Date();
const CURRENT = `${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, '0')}`;
const PAST = '2020-03';

const existingRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  sales_user_id: 'e1',
  period: CURRENT,
  metric: 'new_clinics',
  target_value: '10.00',
  currency: null,
  bonus_type: 'none',
  bonus_threshold_pct: null,
  bonus_amount: null,
  bonus_percent: null,
  bonus_currency: null,
  version: 3,
  updated_at: NOW,
  locked: false,
  ...over,
});

function build() {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  let lockResult: unknown[] = [];
  let lockedFlag = false;
  let insertError: unknown = null;
  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (/FOR UPDATE OF t/.test(sql)) return lockResult;
      if (/INSERT INTO sales_targets/.test(sql)) {
        if (insertError) throw insertError;
        return [{ id: 'new-target' }];
      }
      // The lock flag is read in a SECOND statement, after the row lock (see lockTarget).
      if (/AS locked/.test(sql)) return [{ locked: lockedFlag }];
      if (/FROM sales_bonus_records/.test(sql)) return [];
      return [];
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(manager)),
    query: jest.fn().mockResolvedValue([]),
  } as any;
  const employees = { requireEmployee: jest.fn().mockResolvedValue({ id: 'e1' }) } as any;
  const progress = {
    defaultCurrency: jest.fn().mockResolvedValue('SAR'),
    allowedCurrencies: jest.fn().mockReturnValue(['SAR', 'USD', 'AED', 'EGP']),
    rows: jest.fn().mockResolvedValue([
      { metric: 'new_clinics', period: CURRENT, employeeId: 'e1', target: 10, achieved: 0 },
      { metric: 'subscription_revenue', period: CURRENT, employeeId: 'e1', target: null, achieved: 0 },
    ]),
  } as any;
  const billing = { get: jest.fn().mockResolvedValue('FREE') } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const service = new SalesTargetService(dataSource, employees, progress, billing, audit);
  return {
    service,
    statements,
    employees,
    audit,
    progress,
    setExisting: (row: unknown) => {
      lockResult = row ? [row] : [];
      lockedFlag = (row as { locked?: boolean } | null)?.locked === true;
    },
    setInsertError: (e: unknown) => {
      insertError = e;
    },
    has: (re: RegExp) => statements.some((s) => re.test(s.sql)),
  };
}

const dto = (over: Record<string, unknown> = {}) => ({ targetValue: 10, ...over }) as any;

describe('SalesTargetService.upsert', () => {
  it('creates version 1 with a revision (before = null) and one audit entry', async () => {
    const t = build();
    await t.service.upsert('e1', CURRENT, 'new_clinics', dto(), 'admin');

    expect(t.has(/INSERT INTO sales_targets/)).toBe(true);
    const rev = t.statements.find((s) => /INSERT INTO sales_target_revisions/.test(s.sql))!;
    expect(rev.params![0]).toBe('new-target');
    expect(rev.params![1]).toBe(1);
    expect(rev.params![2]).toBeNull(); // before
    expect(JSON.parse(rev.params![3] as string)).toMatchObject({ targetValue: 10 });
    expect(t.audit.record).toHaveBeenCalledTimes(1);
    expect(t.audit.record.mock.calls[0][0].action).toBe(PLATFORM_ADMIN_AUDIT_ACTION.SALES_TARGET_SET);
  });

  it('updating bumps the version, stores before AND after, and writes the revision in the same transaction', async () => {
    const t = build();
    t.setExisting(existingRow());
    await t.service.upsert('e1', CURRENT, 'new_clinics', dto({ targetValue: 20, expectedVersion: 3 }), 'admin');

    const upd = t.statements.find((s) => /UPDATE sales_targets/.test(s.sql))!;
    expect(upd.params).toContain(4); // version 3 -> 4
    const rev = t.statements.find((s) => /INSERT INTO sales_target_revisions/.test(s.sql))!;
    expect(rev.params![1]).toBe(4);
    expect(JSON.parse(rev.params![2] as string)).toMatchObject({ targetValue: 10 });
    expect(JSON.parse(rev.params![3] as string)).toMatchObject({ targetValue: 20 });
  });

  it('a request that changes nothing writes nothing: no update, no revision, no audit', async () => {
    const t = build();
    t.setExisting(existingRow());
    await t.service.upsert('e1', CURRENT, 'new_clinics', dto({ targetValue: 10, expectedVersion: 3 }), 'admin');

    expect(t.has(/UPDATE sales_targets/)).toBe(false);
    expect(t.has(/INSERT INTO sales_target_revisions/)).toBe(false);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('a stale expectedVersion is a 409 and nothing is written', async () => {
    const t = build();
    t.setExisting(existingRow({ version: 5 }));
    await expect(
      t.service.upsert('e1', CURRENT, 'new_clinics', dto({ targetValue: 20, expectedVersion: 3 }), 'admin'),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_TARGET_VERSION_CONFLICT });
    expect(t.has(/UPDATE sales_targets/)).toBe(false);
    expect(t.has(/INSERT INTO sales_target_revisions/)).toBe(false);
  });

  it('a target whose bonus is approved is locked, even with a matching version and a reason', async () => {
    const t = build();
    t.setExisting(existingRow({ locked: true }));
    await expect(
      t.service.upsert('e1', PAST, 'new_clinics', dto({ targetValue: 99, expectedVersion: 3, reason: 'fix' }), 'admin'),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_TARGET_LOCKED });
    expect(t.has(/UPDATE sales_targets/)).toBe(false);
  });

  it('a closed month needs a reason (create AND edit); a blank reason does not count', async () => {
    for (const setup of [(t: ReturnType<typeof build>) => t.setExisting(null), (t: ReturnType<typeof build>) => t.setExisting(existingRow({ period: PAST }))]) {
      const t = build();
      setup(t);
      await expect(
        t.service.upsert('e1', PAST, 'new_clinics', dto({ targetValue: 20 }), 'admin'),
      ).rejects.toMatchObject({ code: ErrorCode.SALES_REASON_REQUIRED, statusCode: 422 });
      await expect(
        t.service.upsert('e1', PAST, 'new_clinics', dto({ targetValue: 20, reason: '   ' }), 'admin'),
      ).rejects.toMatchObject({ code: ErrorCode.SALES_REASON_REQUIRED });
      expect(t.has(/INSERT INTO sales_targets/)).toBe(false);
      expect(t.has(/UPDATE sales_targets/)).toBe(false);
    }
  });

  it('a closed month with a reason is accepted and the reason lands in the revision and audit', async () => {
    const t = build();
    t.setExisting(existingRow({ period: PAST, version: 1 }));
    await t.service.upsert('e1', PAST, 'new_clinics', dto({ targetValue: 20, reason: '  manager agreed  ' }), 'admin');
    const rev = t.statements.find((s) => /INSERT INTO sales_target_revisions/.test(s.sql))!;
    expect(rev.params![4]).toBe('manager agreed');
    expect(t.audit.record.mock.calls[0][0].after).toMatchObject({ reason: 'manager agreed' });
  });

  it('an open month needs no reason', async () => {
    const t = build();
    await expect(t.service.upsert('e1', CURRENT, 'new_clinics', dto(), 'admin')).resolves.toBeDefined();
  });

  it('requires an ACTIVE employee for an open month, but not for a closed one', async () => {
    const open = build();
    await open.service.upsert('e1', CURRENT, 'new_clinics', dto(), 'admin');
    expect(open.employees.requireEmployee.mock.calls[0][1]).toMatchObject({ requireActive: true });

    const past = build();
    await past.service.upsert('e1', PAST, 'new_clinics', dto({ reason: 'x' }), 'admin');
    expect(past.employees.requireEmployee.mock.calls[0][1]).toMatchObject({ requireActive: false });
  });

  it('two admins creating the same target at once: the unique-key loser gets a 409, not a 500', async () => {
    const t = build();
    t.setInsertError(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(
      t.service.upsert('e1', CURRENT, 'new_clinics', dto(), 'admin'),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_TARGET_VERSION_CONFLICT });
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('locks the row FOR UPDATE before reading the version it compares', async () => {
    const t = build();
    t.setExisting(existingRow());
    await t.service.upsert('e1', CURRENT, 'new_clinics', dto({ targetValue: 20, expectedVersion: 3 }), 'admin');
    const lockIdx = t.statements.findIndex((s) => /FOR UPDATE OF t/.test(s.sql));
    const updIdx = t.statements.findIndex((s) => /UPDATE sales_targets/.test(s.sql));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(updIdx);
  });

  it('invalid rules are refused before any statement runs', async () => {
    const t = build();
    await expect(
      t.service.upsert('e1', CURRENT, 'new_clinics', dto({ targetValue: 1.5 }), 'admin'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(t.statements).toHaveLength(0);
  });

  it('a malformed period is a validation error', async () => {
    const t = build();
    await expect(
      t.service.upsert('e1', '2026-13', 'new_clinics', dto(), 'admin'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });
});

describe('SalesTargetService.remove', () => {
  it('deletes an open-month target and audits the last state and the reason', async () => {
    const t = build();
    t.setExisting(existingRow());
    await t.service.remove('e1', CURRENT, 'new_clinics', 'wrong month', 'admin');
    expect(t.has(/DELETE FROM sales_targets/)).toBe(true);
    const call = t.audit.record.mock.calls[0][0];
    expect(call.action).toBe(PLATFORM_ADMIN_AUDIT_ACTION.SALES_TARGET_DELETED);
    expect(call.before).toMatchObject({ targetValue: 10, metric: 'new_clinics' });
    expect(call.after).toEqual({ reason: 'wrong month' });
  });

  it('404s when there is nothing to delete', async () => {
    const t = build();
    await expect(
      t.service.remove('e1', CURRENT, 'new_clinics', undefined, 'admin'),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_TARGET_NOT_FOUND });
  });

  it('refuses to delete a closed month\'s target', async () => {
    const t = build();
    t.setExisting(existingRow({ period: PAST }));
    await expect(
      t.service.remove('e1', PAST, 'new_clinics', undefined, 'admin'),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_TARGET_LOCKED });
    expect(t.has(/DELETE FROM sales_targets/)).toBe(false);
  });

  it('refuses when the bonus is approved', async () => {
    const t = build();
    t.setExisting(existingRow({ locked: true }));
    await expect(
      t.service.remove('e1', CURRENT, 'new_clinics', undefined, 'admin'),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_TARGET_LOCKED });
    expect(t.has(/DELETE FROM sales_targets/)).toBe(false);
  });
});

describe('SalesTargetService.list', () => {
  it('defaults to the current month and reports billingLive from the billing mode', async () => {
    const t = build();
    const res = await t.service.list('e1');
    expect(res.from).toBe(CURRENT);
    expect(res.to).toBe(CURRENT);
    expect(res.months).toHaveLength(1);
    expect(res.months[0].phase).toBe('current');
    expect(res.billingLive).toBe(false);
    expect(res.currencies).toEqual(['SAR', 'USD', 'AED', 'EGP']);
  });

  it('asks for progress ONCE for the whole range, not once per month', async () => {
    const t = build();
    await t.service.list('e1', '2026-01', '2026-06');
    expect(t.progress.rows).toHaveBeenCalledTimes(1);
  });

  it('refuses a range wider than 24 months', async () => {
    const t = build();
    await expect(t.service.list('e1', '2024-01', '2026-12')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('404s for a non-employee before doing any work', async () => {
    const t = build();
    t.employees.requireEmployee.mockRejectedValueOnce(
      Object.assign(new Error('nf'), { code: ErrorCode.SALES_EMPLOYEE_NOT_FOUND }),
    );
    await expect(t.service.list('nope')).rejects.toMatchObject({
      code: ErrorCode.SALES_EMPLOYEE_NOT_FOUND,
    });
    expect(t.progress.rows).not.toHaveBeenCalled();
  });
});
