import { ErrorCode } from '../../common/errors';
import { PLATFORM_ADMIN_AUDIT_ACTION } from '../platform/platform-admin-audit.service';
import { SalesActivityService } from './sales-activity.service';

/**
 * Unit tests of the activity rules. The real-Postgres behaviour (the subject
 * CHECK, soft delete, ownership scoping, indexes) is proven by
 * `test/platform-sales-activities.e2e-spec.ts`.
 */

const CLINIC = '11111111-1111-4111-8111-111111111111';
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function build(opts: { clinicExists?: boolean } = {}) {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  let deleteRows: unknown[] = [];
  const dataSource = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (/FROM tenants WHERE id/.test(sql)) return opts.clinicExists === false ? [] : [{ id: CLINIC }];
      if (/INSERT INTO sales_activities/.test(sql)) return [{ id: 'a1' }];
      if (/^\s*UPDATE sales_activities/.test(sql)) return [deleteRows, deleteRows.length];
      if (/COUNT\(\*\)/.test(sql)) return [{ total: 0 }];
      if (/FROM sales_activities a/.test(sql)) {
        return [
          {
            id: 'a1',
            type: 'visit',
            occurred_at: new Date('2026-09-01T10:00:00Z'),
            tenant_id: null,
            tenant_name: null,
            tenant_slug: null,
            prospect_name: 'Al Noor',
            outcome: null,
            note: null,
            source: 'admin_manual',
            recorded_by: 'admin',
            recorded_by_name: 'Admin',
            created_at: new Date('2026-09-01T11:00:00Z'),
          },
        ];
      }
      return [];
    }),
  } as any;
  const employees = { requireEmployee: jest.fn().mockResolvedValue({ id: 'e1' }) } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const service = new SalesActivityService(dataSource, employees, audit);
  return {
    service,
    statements,
    employees,
    audit,
    setDeleted: (rows: unknown[]) => {
      deleteRows = rows;
    },
    insert: () => statements.find((s) => /INSERT INTO sales_activities/.test(s.sql)),
  };
}

const failsOn = async (p: Promise<unknown>, field: string) => {
  await expect(p).rejects.toMatchObject({
    code: ErrorCode.VALIDATION_ERROR,
    publicContext: { field },
  });
};

const base = { type: 'visit' as const, occurredAt: daysAgo(1) };

describe('SalesActivityService.create', () => {
  it('needs a clinic or a prospect — exactly one', async () => {
    const t = build();
    await failsOn(t.service.create('e1', base as any, 'admin'), 'tenantId');
    await failsOn(t.service.create('e1', { ...base, prospectName: '   ' } as any, 'admin'), 'tenantId');
    await failsOn(
      t.service.create('e1', { ...base, tenantId: CLINIC, prospectName: 'Al Noor' } as any, 'admin'),
      'prospectName',
    );
    expect(t.insert()).toBeUndefined();
  });

  it('refuses an activity dated in the future, but tolerates a few minutes of clock skew', async () => {
    const t = build();
    await failsOn(
      t.service.create('e1', { ...base, prospectName: 'Al Noor', occurredAt: minutesFromNow(30) } as any, 'admin'),
      'occurredAt',
    );
    await failsOn(
      t.service.create('e1', { ...base, prospectName: 'Al Noor', occurredAt: daysAgo(-1) } as any, 'admin'),
      'occurredAt',
    );
    expect(t.insert()).toBeUndefined();
    await expect(
      t.service.create('e1', { ...base, prospectName: 'Al Noor', occurredAt: minutesFromNow(2) } as any, 'admin'),
    ).resolves.toBeDefined();
  });

  it('refuses an activity so old it is a mistyped year', async () => {
    const t = build();
    await failsOn(
      t.service.create('e1', { ...base, prospectName: 'Al Noor', occurredAt: daysAgo(731) } as any, 'admin'),
      'occurredAt',
    );
    await expect(
      t.service.create('e1', { ...base, prospectName: 'Al Noor', occurredAt: daysAgo(700) } as any, 'admin'),
    ).resolves.toBeDefined();
  });

  it('a clinic that does not exist (or is deleted) is refused', async () => {
    const t = build({ clinicExists: false });
    await failsOn(t.service.create('e1', { ...base, tenantId: CLINIC } as any, 'admin'), 'tenantId');
    expect(t.insert()).toBeUndefined();
  });

  it('stores the trimmed prospect, an empty note as NULL, source admin_manual and the acting admin', async () => {
    const t = build();
    await t.service.create(
      'e1',
      { ...base, prospectName: '  Al Noor Clinic ', note: '   ', outcome: 'interested' } as any,
      'admin',
    );
    const ins = t.insert()!;
    expect(ins.sql).toMatch(/'admin_manual'/);
    expect(ins.params![0]).toBe('e1');
    expect(ins.params![1]).toBeNull(); //          tenant
    expect(ins.params![2]).toBe('Al Noor Clinic'); // trimmed
    expect(ins.params![5]).toBe('interested');
    expect(ins.params![6]).toBeNull(); //          note
    expect(ins.params![7]).toBe('admin');
  });

  it('audits with the clinic as the tenant, and never copies the free-text note into the log', async () => {
    const t = build();
    await t.service.create('e1', { ...base, tenantId: CLINIC, note: 'private remark' } as any, 'admin');
    const call = t.audit.record.mock.calls[0][0];
    expect(call.action).toBe(PLATFORM_ADMIN_AUDIT_ACTION.SALES_ACTIVITY_LOGGED);
    expect(call.tenantId).toBe(CLINIC);
    expect(call.after).toMatchObject({ employeeId: 'e1', type: 'visit', hasNote: true });
    expect(JSON.stringify(call)).not.toContain('private remark');
  });

  it('a deactivated employee may still be logged for (requireActive is not asked for)', async () => {
    const t = build();
    await t.service.create('e1', { ...base, prospectName: 'Al Noor' } as any, 'admin');
    expect(t.employees.requireEmployee.mock.calls[0][1]).toBeUndefined();
  });
});

describe('SalesActivityService.list', () => {
  const q = (over: Record<string, unknown> = {}) => ({ page: 1, limit: 20, offset: () => 0, ...over }) as any;

  it('`to` is an inclusive day: the upper bound is the start of the NEXT day (UTC)', async () => {
    const t = build();
    await t.service.list('e1', q({ from: '2026-09-01', to: '2026-09-30' }));
    const rows = t.statements.find((s) => /ORDER BY a\.occurred_at DESC/.test(s.sql))!;
    expect(rows.params).toContain('2026-09-01T00:00:00.000Z');
    expect(rows.params).toContain('2026-10-01T00:00:00.000Z');
  });

  it('rejects an impossible date and an inverted range', async () => {
    const t = build();
    await failsOn(t.service.list('e1', q({ from: '2026-02-31' })), 'from');
    await failsOn(t.service.list('e1', q({ from: '2026-09-30', to: '2026-09-01' })), 'from');
  });

  it('always scopes to the employee and hides soft-deleted rows', async () => {
    const t = build();
    await t.service.list('e1', q());
    const rows = t.statements.find((s) => /ORDER BY a\.occurred_at DESC/.test(s.sql))!;
    expect(rows.sql).toMatch(/a\.sales_user_id = \$1/);
    expect(rows.sql).toMatch(/a\.deleted_at IS NULL/);
  });

  it('maps a row, labelling a prospect (no clinic) and who logged it', async () => {
    const t = build();
    const out = await t.service.list('e1', q());
    expect(out.data[0]).toMatchObject({
      id: 'a1',
      clinic: null,
      prospectName: 'Al Noor',
      source: 'admin_manual',
      recordedBy: { id: 'admin', name: 'Admin' },
      occurredAt: '2026-09-01T10:00:00.000Z',
    });
  });
});

describe('SalesActivityService.remove', () => {
  it('soft-deletes only this employee\'s live activity, conditionally, and audits it', async () => {
    const t = build();
    t.setDeleted([{ id: 'a1', tenant_id: CLINIC, type: 'call', prospect_name: null }]);
    await expect(t.service.remove('e1', 'a1', 'admin')).resolves.toEqual({ deleted: true });
    const upd = t.statements.find((s) => /^\s*UPDATE sales_activities/.test(s.sql))!;
    expect(upd.sql).toMatch(/SET deleted_at = now\(\)/);
    expect(upd.sql).toMatch(/sales_user_id = \$2/);
    expect(upd.sql).toMatch(/deleted_at IS NULL/);
    expect(upd.params).toEqual(['a1', 'e1']);
    expect(t.audit.record.mock.calls[0][0]).toMatchObject({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ACTIVITY_DELETED,
      tenantId: CLINIC,
      before: { employeeId: 'e1', type: 'call' },
    });
  });

  it('an unknown, already-deleted or other employee\'s activity is a 404 and audits nothing', async () => {
    const t = build();
    t.setDeleted([]);
    await expect(t.service.remove('e1', 'a1', 'admin')).rejects.toMatchObject({
      code: ErrorCode.SALES_ACTIVITY_NOT_FOUND,
    });
    expect(t.audit.record).not.toHaveBeenCalled();
  });
});
