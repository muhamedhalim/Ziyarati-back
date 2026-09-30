import { ErrorCode } from '../../common/errors';
import { PLATFORM_ADMIN_AUDIT_ACTION } from '../platform/platform-admin-audit.service';
import { SalesAssignmentService } from './sales-assignment.service';

type Handler = [RegExp, unknown | ((params: unknown[]) => unknown)];

/** A query fn that answers by SQL pattern, and records every call in order. */
function scripted(handlers: Handler[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fn = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const [re, out] of handlers) {
      if (re.test(sql)) return typeof out === 'function' ? (out as any)(params) : out;
    }
    throw new Error(`unscripted query: ${sql.slice(0, 120)}`);
  });
  return { fn, calls };
}

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';
const EMP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function build(handlers: Handler[], employeesImpl?: Partial<{ requireEmployee: jest.Mock }>) {
  const { fn, calls } = scripted(handlers);
  const manager = { query: fn } as any;
  const dataSource = {
    query: fn,
    transaction: jest.fn(async (cb: (m: any) => unknown) => cb(manager)),
  } as any;
  const employees = {
    requireEmployee: jest.fn().mockResolvedValue({ id: EMP, isActive: true }),
    ...employeesImpl,
  } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const service = new SalesAssignmentService(dataSource, employees, audit);
  return { service, calls, employees, audit, dataSource };
}

const tenantRows = (rows: Array<[string, string]>) => [
  /FROM tenants\s+WHERE id = ANY/,
  rows.map(([id, approval_status]) => ({ id, approval_status })),
] as Handler;

const activeRows = (rows: Array<[string, string, string]>) => [
  /FOR UPDATE/,
  rows.map(([id, tenant_id, sales_user_id]) => ({ id, tenant_id, sales_user_id })),
] as Handler;

const insertReturning = (tenantIds: string[]) => [
  /INSERT INTO sales_clinic_assignments/,
  tenantIds.map((tenant_id) => ({ tenant_id })),
] as Handler;

describe('SalesAssignmentService.assign', () => {
  it('assigns new clinics in one set-based INSERT and audits ONE bulk entry', async () => {
    const { service, calls, audit } = build([
      tenantRows([[T1, 'APPROVED'], [T2, 'APPROVED']]),
      activeRows([]),
      insertReturning([T1, T2]),
    ]);

    const res = await service.assign(EMP, { tenantIds: [T1, T2] } as any, ACTOR);

    expect(res).toEqual({ requested: 2, assigned: 2, reassigned: 0, skipped: [] });
    expect(calls.filter((c) => /INSERT INTO sales_clinic_assignments/.test(c.sql))).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ASSIGNMENT_CREATED,
        userId: ACTOR,
        entityId: EMP,
        tenantId: undefined, // bulk: not attributed to a single clinic
      }),
    );
  });

  it('attributes a single-clinic assignment to that clinic in the audit trail', async () => {
    const { service, audit } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([]),
      insertReturning([T1]),
    ]);
    await service.assign(EMP, { tenantIds: [T1] } as any, ACTOR);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T1 }));
  });

  it('requires an ACTIVE employee, inside the same transaction', async () => {
    const { service, employees, dataSource } = build([]);
    employees.requireEmployee.mockRejectedValueOnce(
      Object.assign(new Error('inactive'), { code: ErrorCode.SALES_EMPLOYEE_INACTIVE }),
    );
    await expect(
      service.assign(EMP, { tenantIds: [T1] } as any, ACTOR),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_EMPLOYEE_INACTIVE });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(employees.requireEmployee).toHaveBeenCalledWith(
      EMP,
      expect.objectContaining({ requireActive: true, manager: expect.anything() }),
    );
  });

  it('skips unknown / deleted and REJECTED clinics with distinct reasons', async () => {
    const { service, calls } = build([
      tenantRows([[T1, 'REJECTED'], [T2, 'APPROVED']]), // T3 is absent (deleted or unknown)
      activeRows([]),
      insertReturning([T2]),
    ]);
    const res = await service.assign(EMP, { tenantIds: [T1, T2, T3] } as any, ACTOR);
    expect(res.assigned).toBe(1);
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { tenantId: T1, reason: 'clinic_rejected' },
        { tenantId: T3, reason: 'clinic_not_found' },
      ]),
    );
    // only the assignable clinic reaches the INSERT
    const insert = calls.find((c) => /INSERT INTO sales_clinic_assignments/.test(c.sql))!;
    expect(insert.params[2]).toEqual([T2]);
  });

  it('is idempotent for the same employee: already_assigned_to_employee, no INSERT', async () => {
    const { service, calls } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([['a1', T1, EMP]]),
    ]);
    const res = await service.assign(EMP, { tenantIds: [T1] } as any, ACTOR);
    expect(res).toMatchObject({
      assigned: 0,
      skipped: [{ tenantId: T1, reason: 'already_assigned_to_employee' }],
    });
    expect(calls.some((c) => /INSERT INTO sales_clinic_assignments/.test(c.sql))).toBe(false);
  });

  it('skips a clinic another employee owns by default, naming the owner', async () => {
    const { service, calls, audit } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([['a1', T1, OTHER]]),
    ]);
    const res = await service.assign(EMP, { tenantIds: [T1] } as any, ACTOR);
    expect(res.skipped).toEqual([
      { tenantId: T1, reason: 'assigned_to_other', ownerEmployeeId: OTHER },
    ]);
    expect(calls.some((c) => /UPDATE sales_clinic_assignments/.test(c.sql))).toBe(false);
    expect(audit.record).not.toHaveBeenCalled(); // nothing changed, nothing audited
  });

  it('reassign closes the old row (reason "reassigned") BEFORE inserting, and audits the previous owner', async () => {
    const { service, calls, audit } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([['a1', T1, OTHER]]),
      [/UPDATE sales_clinic_assignments/, []],
      insertReturning([T1]),
    ]);
    const res = await service.assign(
      EMP,
      { tenantIds: [T1], onConflict: 'reassign' } as any,
      ACTOR,
    );
    expect(res).toMatchObject({ assigned: 1, reassigned: 1, skipped: [] });

    const order = calls.map((c) =>
      /UPDATE sales_clinic_assignments/.test(c.sql)
        ? 'close'
        : /INSERT INTO sales_clinic_assignments/.test(c.sql)
          ? 'insert'
          : 'other',
    );
    expect(order.indexOf('close')).toBeLessThan(order.indexOf('insert'));
    const close = calls.find((c) => /UPDATE sales_clinic_assignments/.test(c.sql))!;
    expect(close.sql).toContain(`end_reason = 'reassigned'`);
    expect(close.params[0]).toEqual(['a1']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ before: { previousOwners: { [T1]: OTHER } } }),
    );
  });

  it('locks existing owners in tenant order so overlapping batches cannot deadlock', async () => {
    const { service, calls } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([]),
      insertReturning([T1]),
    ]);
    await service.assign(EMP, { tenantIds: [T1] } as any, ACTOR);
    const lock = calls.find((c) => /FOR UPDATE/.test(c.sql))!;
    expect(lock.sql).toMatch(/ORDER BY tenant_id\s+FOR UPDATE/);
  });

  it('acquired credit is once-per-clinic-ever: an already-credited clinic is skipped, not double-credited', async () => {
    const { service, calls } = build([
      tenantRows([[T1, 'APPROVED'], [T2, 'APPROVED']]),
      activeRows([]),
      [/kind = 'acquired'/, [{ tenant_id: T1 }]],
      insertReturning([T2]),
    ]);
    const res = await service.assign(
      EMP,
      { tenantIds: [T1, T2], kind: 'acquired' } as any,
      ACTOR,
    );
    expect(res.assigned).toBe(1);
    expect(res.skipped).toEqual([{ tenantId: T1, reason: 'acquisition_already_credited' }]);
    const insert = calls.find((c) => /INSERT INTO sales_clinic_assignments/.test(c.sql))!;
    expect(insert.params[3]).toEqual(['acquired']);
  });

  it('does not query acquisition history for a managed assignment', async () => {
    const { service, calls } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([]),
      insertReturning([T1]),
    ]);
    await service.assign(EMP, { tenantIds: [T1] } as any, ACTOR);
    expect(calls.some((c) => /kind = 'acquired'/.test(c.sql))).toBe(false);
    expect(calls.find((c) => /INSERT INTO/.test(c.sql))!.params[3]).toEqual(['managed']);
  });

  it('a lost race (ON CONFLICT DO NOTHING returned no row) is a skip, not a failure — and is not reported as reassigned', async () => {
    const { service } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([['a1', T1, OTHER]]),
      [/UPDATE sales_clinic_assignments/, []],
      insertReturning([]), // someone else won T1 between our lock and our insert
    ]);
    const res = await service.assign(
      EMP,
      { tenantIds: [T1], onConflict: 'reassign' } as any,
      ACTOR,
    );
    expect(res).toMatchObject({
      assigned: 0,
      reassigned: 0,
      skipped: [{ tenantId: T1, reason: 'concurrent_assignment' }],
    });
  });

  it('maps a unique violation escaping the acquired-credit index to 409 SALES_CLINIC_ALREADY_ASSIGNED', async () => {
    const { service } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([]),
      [/kind = 'acquired'/, []], // nobody has credit yet — the race is on the INSERT
      [
        /INSERT INTO sales_clinic_assignments/,
        () => {
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        },
      ],
    ]);
    await expect(
      service.assign(EMP, { tenantIds: [T1], kind: 'acquired' } as any, ACTOR),
    ).rejects.toMatchObject({
      code: ErrorCode.SALES_CLINIC_ALREADY_ASSIGNED,
      statusCode: 409,
    });
  });

  it('does not swallow unrelated database errors', async () => {
    const { service } = build([
      tenantRows([[T1, 'APPROVED']]),
      activeRows([]),
      [
        /INSERT INTO sales_clinic_assignments/,
        () => {
          throw Object.assign(new Error('connection lost'), { code: '08006' });
        },
      ],
    ]);
    await expect(
      service.assign(EMP, { tenantIds: [T1] } as any, ACTOR),
    ).rejects.toThrow('connection lost');
  });
});

describe('SalesAssignmentService.end', () => {
  it('ends only ACTIVE rows in a conditional UPDATE and reports unknown vs already-ended ids', async () => {
    const A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
    const A3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
    const { service, calls, audit } = build([
      // TypeORM returns a [rows, affectedCount] tuple for UPDATE ... RETURNING.
      [/UPDATE sales_clinic_assignments/, [[{ id: A1, tenant_id: T1, sales_user_id: EMP }], 1]],
      [/SELECT id FROM sales_clinic_assignments/, [{ id: A1 }, { id: A2 }]],
    ]);

    const res = await service.end({ assignmentIds: [A1, A2, A3] } as any, ACTOR);

    expect(res).toEqual({
      requested: 3,
      ended: 1,
      skipped: [
        { assignmentId: A2, reason: 'already_ended' },
        { assignmentId: A3, reason: 'not_found' },
      ],
    });
    const update = calls.find((c) => /UPDATE/.test(c.sql))!;
    expect(update.sql).toContain('ended_at IS NULL');
    expect(update.sql).toContain(`end_reason = 'unassigned'`);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ASSIGNMENT_ENDED,
        entityId: A1,
        tenantId: T1,
      }),
    );
  });

  it('a repeat call is a harmless no-op and writes no audit entry', async () => {
    const A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    const { service, audit } = build([
      [/UPDATE sales_clinic_assignments/, [[], 0]],
      [/SELECT id FROM sales_clinic_assignments/, [{ id: A1 }]],
    ]);
    const res = await service.end({ assignmentIds: [A1] } as any, ACTOR);
    expect(res).toMatchObject({ ended: 0, skipped: [{ assignmentId: A1, reason: 'already_ended' }] });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('SalesAssignmentService.transfer', () => {
  const A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  const A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';

  it('refuses a transfer to the same employee', async () => {
    const { service, dataSource } = build([]);
    await expect(
      service.transfer(EMP, { toEmployeeId: EMP, all: true } as any, ACTOR),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('the SOURCE may be deactivated, the TARGET must be active', async () => {
    const { service, employees } = build([
      [/FOR UPDATE/, []],
      [/COUNT\(\*\)::int AS c/, [{ c: 0 }]],
    ]);
    await service.transfer(EMP, { toEmployeeId: OTHER, all: true } as any, ACTOR);
    const [from, to] = employees.requireEmployee.mock.calls;
    expect(from[0]).toBe(EMP);
    expect(from[1].requireActive).toBeUndefined();
    expect(to[0]).toBe(OTHER);
    expect(to[1].requireActive).toBe(true);
  });

  it('moves a chosen subset: closes as "transferred" then inserts MANAGED rows for the target', async () => {
    const { service, calls, audit } = build([
      [/FOR UPDATE/, [{ id: A1, tenant_id: T1 }]],
      [/UPDATE sales_clinic_assignments/, []],
      insertReturning([T1]),
      [/COUNT\(\*\)::int AS c/, [{ c: 4 }]],
    ]);
    const res = await service.transfer(
      EMP,
      { toEmployeeId: OTHER, assignmentIds: [A1] } as any,
      ACTOR,
    );
    expect(res).toEqual({ requested: 1, transferred: 1, skipped: [], remaining: 4 });
    const close = calls.find((c) => /UPDATE sales_clinic_assignments/.test(c.sql))!;
    expect(close.sql).toContain(`end_reason = 'transferred'`);
    const insert = calls.find((c) => /INSERT INTO sales_clinic_assignments/.test(c.sql))!;
    expect(insert.sql).toContain(`'managed'`);
    expect(insert.params[0]).toBe(OTHER);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ASSIGNMENT_TRANSFERRED,
        entityId: EMP,
        tenantId: T1,
      }),
    );
  });

  it("an assignment id that is not THIS employee's is never touched (IDOR-safe)", async () => {
    const { service, calls } = build([
      [/FOR UPDATE/, [{ id: A1, tenant_id: T1 }]], // A2 belongs to someone else, so it is not returned
      [/UPDATE sales_clinic_assignments/, []],
      insertReturning([T1]),
      [/COUNT\(\*\)::int AS c/, [{ c: 0 }]],
    ]);
    const res = await service.transfer(
      EMP,
      { toEmployeeId: OTHER, assignmentIds: [A1, A2] } as any,
      ACTOR,
    );
    expect(res.skipped).toEqual([{ assignmentId: A2, reason: 'not_owned_by_employee' }]);
    const lock = calls.find((c) => /FOR UPDATE/.test(c.sql))!;
    expect(lock.sql).toContain('sales_user_id = $1');
    expect(lock.params[0]).toBe(EMP);
    const close = calls.find((c) => /UPDATE sales_clinic_assignments/.test(c.sql))!;
    expect(close.params[0]).toEqual([A1]);
  });

  it('`all` is capped per call and reports how many clinics remain', async () => {
    const { service, calls } = build([
      [/FOR UPDATE/, [{ id: A1, tenant_id: T1 }]],
      [/UPDATE sales_clinic_assignments/, []],
      insertReturning([T1]),
      [/COUNT\(\*\)::int AS c/, [{ c: 350 }]],
    ]);
    const res = await service.transfer(EMP, { toEmployeeId: OTHER, all: true } as any, ACTOR);
    expect(res.remaining).toBe(350);
    expect(calls.find((c) => /FOR UPDATE/.test(c.sql))!.sql).toContain('LIMIT 200');
  });

  it('transfers nothing (and audits nothing) when the source owns no clinics', async () => {
    const { service, audit } = build([
      [/FOR UPDATE/, []],
      [/COUNT\(\*\)::int AS c/, [{ c: 0 }]],
    ]);
    const res = await service.transfer(EMP, { toEmployeeId: OTHER, all: true } as any, ACTOR);
    expect(res).toMatchObject({ transferred: 0, remaining: 0 });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('SalesAssignmentService.listClinics (picker)', () => {
  const q = (over: Record<string, unknown> = {}) =>
    ({
      page: 1,
      limit: 20,
      assignment: 'unassigned',
      sortBy: 'name',
      sortDir: 'ASC',
      offset: () => 0,
      ...over,
    }) as any;

  it('selects the page in a CTE first, in exactly two statements (count + page)', async () => {
    const { service, calls } = build([
      [/COUNT\(\*\)::int AS total/, [{ total: 0 }]],
      [/WITH page AS/, []],
    ]);
    await service.listClinics(q());
    expect(calls).toHaveLength(2);
    const page = calls.find((c) => /WITH page AS/.test(c.sql))!;
    expect(page.sql.indexOf('LIMIT')).toBeLessThan(page.sql.indexOf('LATERAL'));
  });

  it('hides REJECTED clinics unless a status is asked for, and never deleted ones', async () => {
    const { service, calls } = build([
      [/COUNT\(\*\)::int AS total/, [{ total: 0 }]],
      [/WITH page AS/, []],
    ]);
    await service.listClinics(q());
    expect(calls[0].sql).toContain('t.deleted_at IS NULL');
    expect(calls[0].sql).toContain(`t.approval_status <> 'REJECTED'`);
  });

  it('filters by ownership and excludes the employee\'s own clinics, with bound parameters', async () => {
    const { service, calls } = build([
      [/COUNT\(\*\)::int AS total/, [{ total: 0 }]],
      [/WITH page AS/, []],
    ]);
    await service.listClinics(q({ assignment: 'assigned', excludeEmployeeId: EMP, search: 'smile' }));
    expect(calls[0].sql).toContain('a.id IS NOT NULL');
    expect(calls[0].sql).toContain('a.sales_user_id <> $');
    expect(calls[0].params).toEqual(expect.arrayContaining([EMP, '%smile%']));
    expect(calls[0].sql).not.toContain('smile');
  });

  it('maps the current owner onto each row, and null when unowned', async () => {
    const { service } = build([
      [/COUNT\(\*\)::int AS total/, [{ total: 2 }]],
      [
        /WITH page AS/,
        [
          {
            tenant_id: T1, name: 'A', slug: 'a', contact_email: null, contact_phone: null,
            is_active: true, approval_status: 'APPROVED', created_at: '2026-01-01T00:00:00Z',
            subscription_status: 'ACTIVE', plan_name: 'Pro',
            owner_id: EMP, owner_kind: 'managed', owner_assigned_at: '2026-02-01T00:00:00Z',
            owner_name: 'Rep One', owner_email: 'rep@x.io',
          },
          {
            tenant_id: T2, name: 'B', slug: 'b', contact_email: null, contact_phone: null,
            is_active: true, approval_status: 'APPROVED', created_at: null,
            subscription_status: null, plan_name: null,
            owner_id: null, owner_kind: null, owner_assigned_at: null,
            owner_name: null, owner_email: null,
          },
        ],
      ],
    ]);
    const res = await service.listClinics(q({ assignment: 'any' }));
    expect(res.data[0].owner).toEqual({
      employeeId: EMP, name: 'Rep One', kind: 'managed', assignedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(res.data[1].owner).toBeNull();
    expect(res.data[0]).toMatchObject({ planName: 'Pro', subscriptionStatus: 'ACTIVE' });
  });
});

describe('SalesAssignmentService.listEmployeeClinics (portfolio)', () => {
  const q = (over: Record<string, unknown> = {}) =>
    ({
      page: 1, limit: 20, status: 'active', sortBy: 'assignedAt', sortDir: 'DESC',
      offset: () => 0, ...over,
    }) as any;

  it('404s (identically) for a non-employee before running any listing query', async () => {
    const { service, calls, employees } = build([]);
    employees.requireEmployee.mockRejectedValueOnce(
      Object.assign(new Error('nf'), { code: ErrorCode.SALES_EMPLOYEE_NOT_FOUND }),
    );
    await expect(service.listEmployeeClinics(EMP, q())).rejects.toMatchObject({
      code: ErrorCode.SALES_EMPLOYEE_NOT_FOUND,
    });
    expect(calls).toHaveLength(0);
  });

  it("is scoped to THIS employee's rows and excludes deleted clinics", async () => {
    const { service, calls } = build([
      [/COUNT\(\*\)::int AS total/, [{ total: 0 }]],
      [/WITH page AS/, []],
    ]);
    await service.listEmployeeClinics(EMP, q());
    expect(calls[0].sql).toContain('a.sales_user_id = $1');
    expect(calls[0].params[0]).toBe(EMP);
    expect(calls[0].sql).toContain('t.deleted_at IS NULL');
    expect(calls[0].sql).toContain('a.ended_at IS NULL'); // default status = active
  });

  it('runs the activity lateral AFTER paging unless it is the sort key or a filter', async () => {
    const { service, calls } = build([
      [/COUNT\(\*\)::int AS total/, [{ total: 0 }]],
      [/WITH page AS/, []],
    ]);
    await service.listEmployeeClinics(EMP, q({ sortBy: 'name' }));
    const page = calls.find((c) => /WITH page AS/.test(c.sql))!;
    expect(page.sql.indexOf('sales_activities')).toBeGreaterThan(page.sql.indexOf('LIMIT'));
  });

  it('staleDays runs the lateral BEFORE paging and treats never-worked clinics as stale', async () => {
    const { service, calls } = build([
      [/COUNT\(\*\)::int AS total/, [{ total: 0 }]],
      [/WITH page AS/, []],
    ]);
    await service.listEmployeeClinics(EMP, q({ staleDays: 30 }));
    const page = calls.find((c) => /WITH page AS/.test(c.sql))!;
    expect(page.sql.indexOf('sales_activities')).toBeLessThan(page.sql.indexOf('LIMIT'));
    expect(page.sql).toContain('act.last_activity_at IS NULL OR act.last_activity_at <');
    expect(page.params).toContain(30);
  });

  it('sortBy=lastActivity orders by the lateral and keeps a stable tiebreaker', async () => {
    const { service, calls } = build([
      [/COUNT\(\*\)::int AS total/, [{ total: 0 }]],
      [/WITH page AS/, []],
    ]);
    await service.listEmployeeClinics(EMP, q({ sortBy: 'lastActivity', sortDir: 'ASC' }));
    const page = calls.find((c) => /WITH page AS/.test(c.sql))!;
    expect(page.sql).toMatch(/ORDER BY act\.last_activity_at ASC NULLS LAST, a\.id ASC/);
  });
});

describe('SalesAssignmentService.clinicHistory', () => {
  it('404s TENANT_NOT_FOUND for an unknown or deleted clinic', async () => {
    const { service } = build([[/FROM tenants WHERE id = \$1/, []]]);
    await expect(
      service.clinicHistory(T1, { page: 1, limit: 20, offset: () => 0 } as any),
    ).rejects.toMatchObject({ code: ErrorCode.TENANT_NOT_FOUND });
  });

  it('returns newest first with a stable tiebreaker', async () => {
    const { service, calls } = build([
      [/FROM tenants WHERE id = \$1/, [{ id: T1 }]],
      [/COUNT\(\*\)::int AS total/, [{ total: 1 }]],
      [
        /SELECT a\.id, a\.sales_user_id/,
        [
          {
            id: 'a1', sales_user_id: EMP, kind: 'acquired',
            assigned_at: '2026-01-01T00:00:00Z', ended_at: '2026-03-01T00:00:00Z',
            end_reason: 'reassigned', note: null, full_name: 'Rep One', email: 'rep@x.io',
          },
        ],
      ],
    ]);
    const res = await service.clinicHistory(T1, { page: 1, limit: 20, offset: () => 0 } as any);
    expect(res.data[0]).toMatchObject({
      assignmentId: 'a1',
      employee: { id: EMP, name: 'Rep One' },
      endReason: 'reassigned',
    });
    expect(calls.find((c) => /a\.assigned_at DESC, a\.id DESC/.test(c.sql))).toBeDefined();
  });
});

describe('SalesAssignmentService.assignBatch (shared by bulk assign and the Excel import)', () => {
  const batch = (
    items: Array<{ tenantId: string; kind: 'acquired' | 'managed'; note: string | null }>,
    handlers: Handler[],
    onConflict: 'skip' | 'reassign' = 'skip',
  ) => {
    const b = build(handlers);
    const m = { query: b.dataSource.query } as any;
    return {
      ...b,
      run: () => b.service.assignBatch(m, { employeeId: EMP, items, onConflict, actorUserId: ACTOR }),
    };
  };

  it('writes each item\'s OWN kind and note in one INSERT, in the same order as the ids', async () => {
    const { run, calls } = batch(
      [
        { tenantId: T1, kind: 'acquired', note: 'brought in' },
        { tenantId: T2, kind: 'managed', note: null },
      ],
      [tenantRows([[T1, 'APPROVED'], [T2, 'APPROVED']]), activeRows([]), [/kind = 'acquired'/, []], insertReturning([T1, T2])],
    );
    const res = await run();
    expect(res.result).toEqual({ requested: 2, assigned: 2, reassigned: 0, skipped: [] });
    const insert = calls.filter((c) => /INSERT INTO sales_clinic_assignments/.test(c.sql));
    expect(insert).toHaveLength(1);
    expect(insert[0].params).toEqual([EMP, ACTOR, [T1, T2], ['acquired', 'managed'], ['brought in', null]]);
  });

  it('checks acquisition credit only for the items that ask for it', async () => {
    const { run, calls } = batch(
      [
        { tenantId: T1, kind: 'acquired', note: null },
        { tenantId: T2, kind: 'managed', note: null },
      ],
      [
        tenantRows([[T1, 'APPROVED'], [T2, 'APPROVED']]),
        activeRows([]),
        [/kind = 'acquired'/, [{ tenant_id: T1 }, { tenant_id: T2 }]], // both credited to someone
        insertReturning([T2]),
      ],
    );
    const res = await run();
    // T1 asked for credit and it is taken; T2 is managed, so credit is irrelevant to it.
    expect(res.result.skipped).toEqual([{ tenantId: T1, reason: 'acquisition_already_credited' }]);
    expect(res.result.assigned).toBe(1);
    expect(calls.find((c) => /kind = 'acquired'/.test(c.sql))!.params).toEqual([[T1]]);
    expect(calls.find((c) => /INSERT INTO/.test(c.sql))!.params[2]).toEqual([T2]);
  });

  it('is the authority on conflicts: it re-reads ownership under FOR UPDATE, whatever the caller decided', async () => {
    const { run, calls } = batch(
      [{ tenantId: T1, kind: 'managed', note: null }],
      [tenantRows([[T1, 'APPROVED']]), activeRows([['a1', T1, OTHER]])],
    );
    const res = await run();
    expect(res.result.skipped).toEqual([{ tenantId: T1, reason: 'assigned_to_other', ownerEmployeeId: OTHER }]);
    expect(calls.some((c) => /FOR UPDATE/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });
});
