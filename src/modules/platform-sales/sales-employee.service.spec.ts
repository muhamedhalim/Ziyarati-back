import { ErrorCode } from '../../common/errors';
import { SalesEmployeeService } from './sales-employee.service';

type QueryFn = jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;

function build() {
  const query: QueryFn = jest.fn();
  const dataSource = { query } as any;
  const staff = { summarize: jest.fn() } as any;
  const billingMode = { get: jest.fn() } as any;
  const progress = {
    rows: jest.fn().mockResolvedValue([]),
    loadTeamTargets: jest.fn().mockResolvedValue([]),
  } as any;
  const service = new SalesEmployeeService(
    dataSource,
    staff,
    billingMode,
    progress,
  );
  return { service, query, staff, billingMode, progress };
}

const ROW = {
  id: 'e1',
  email: 'rep@x.io',
  full_name: 'Rep One',
  phone: '+966500000000',
  is_active: true,
};

describe('SalesEmployeeService.requireEmployee', () => {
  it('returns the employee when the id is a live platform_sales user', async () => {
    const { service, query } = build();
    query.mockResolvedValueOnce([ROW]);
    await expect(service.requireEmployee('e1')).resolves.toEqual({
      id: 'e1',
      email: 'rep@x.io',
      fullName: 'Rep One',
      phone: '+966500000000',
      isActive: true,
    });
  });

  it('scopes the lookup to platform users, live rows and the platform_sales role IN SQL', async () => {
    const { service, query } = build();
    query.mockResolvedValueOnce([ROW]);
    await service.requireEmployee('e1');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('u."tenantId" IS NULL');
    expect(sql).toContain('u.deleted_at IS NULL');
    expect(sql).toContain(`r.slug = 'platform_sales'`);
    expect(params).toEqual(['e1']);
  });

  it('a tenant user, super admin, support user, deleted user and random id are ALL the same 404', async () => {
    const { service, query } = build();
    query.mockResolvedValue([]); // none of them match the WHERE clause
    for (const id of ['tenant-user', 'super-admin', 'support', 'deleted', 'nope']) {
      await expect(service.requireEmployee(id)).rejects.toMatchObject({
        code: ErrorCode.SALES_EMPLOYEE_NOT_FOUND,
        statusCode: 404,
      });
    }
  });

  it('refuses a deactivated employee only when requireActive is set', async () => {
    const { service, query } = build();
    query.mockResolvedValue([{ ...ROW, is_active: false }]);
    await expect(service.requireEmployee('e1')).resolves.toMatchObject({
      isActive: false,
    });
    await expect(
      service.requireEmployee('e1', { requireActive: true }),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_EMPLOYEE_INACTIVE });
  });

  it('reads through the transaction manager when one is passed', async () => {
    const { service, query } = build();
    const managerQuery = jest.fn().mockResolvedValue([ROW]);
    await service.requireEmployee('e1', { manager: { query: managerQuery } as any });
    expect(managerQuery).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('SalesEmployeeService.list', () => {
  const dto = (over: Record<string, unknown> = {}) =>
    ({
      page: 1,
      limit: 20,
      sortBy: 'createdAt',
      sortDir: 'DESC',
      offset: () => 0,
      ...over,
    }) as any;

  it('picks the page from users alone, then fetches stats for exactly those ids in ONE query', async () => {
    const { service, query, staff } = build();
    query
      .mockResolvedValueOnce([{ total: 2 }]) // count
      .mockResolvedValueOnce([{ id: 'b' }, { id: 'a' }]) // page ids
      .mockResolvedValueOnce([
        { id: 'a', assigned_count: 3, ended_count: 1, last_activity_at: '2026-09-01T10:00:00Z' },
        { id: 'b', assigned_count: 0, ended_count: 0, last_activity_at: null },
      ]); // stats
    staff.summarize.mockResolvedValueOnce([
      { id: 'b', email: 'b@x.io' },
      { id: 'a', email: 'a@x.io' },
    ]);

    const res = await service.list(dto());

    expect(query).toHaveBeenCalledTimes(3);
    expect(staff.summarize).toHaveBeenCalledWith(['b', 'a']);
    // order follows the SQL page, stats are merged by id
    expect(res.data.map((d) => d.id)).toEqual(['b', 'a']);
    expect(res.data[1]).toMatchObject({
      assignedCount: 3,
      lastActivityAt: '2026-09-01T10:00:00.000Z',
    });
    expect(res.data[0]).toMatchObject({ assignedCount: 0, lastActivityAt: null });
    expect(res.total).toBe(2);
  });

  it('attaches every employee targets from ONE progress call for the page', async () => {
    const { service, query, staff, progress } = build();
    query
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
      .mockResolvedValueOnce([]);
    staff.summarize.mockResolvedValueOnce([
      { id: 'a', email: 'a@x.io' },
      { id: 'b', email: 'b@x.io' },
    ]);
    progress.rows.mockResolvedValueOnce([
      {
        employeeId: 'a', metric: 'new_clinics', period: '2026-09', target: 5,
        currency: null, achieved: 2, percentage: 40, isCompleted: false, expectedPercentage: 100, onTrack: false,
        bonusRule: null, locked: false, excludedCurrencies: [], updatedAt: null,
      },
    ]);

    const res = await service.list(dto({ period: '2026-09' }));

    expect(progress.rows).toHaveBeenCalledTimes(1);
    expect(progress.rows.mock.calls[0][0]).toMatchObject({
      employeeIds: ['a', 'b'],
      includeUntargeted: false,
    });
    expect(res.data[0].targets).toEqual([
      { metric: 'new_clinics', target: 5, currency: null, achieved: 2, percentage: 40, isCompleted: false, expectedPercentage: 100, onTrack: false },
    ]);
    expect(res.data[1].targets).toEqual([]);
  });

  it('does not join the aggregates unless they are the sort key', async () => {
    const { service, query, staff } = build();
    query.mockResolvedValue([]);
    query.mockResolvedValueOnce([{ total: 0 }]);
    staff.summarize.mockResolvedValue([]);

    await service.list(dto({ sortBy: 'name', sortDir: 'ASC' }));
    const pageSql = query.mock.calls[1][0];
    expect(pageSql).not.toContain('sales_clinic_assignments');
    expect(pageSql).not.toContain('sales_activities');
    expect(pageSql).toContain('LOWER(COALESCE(u.full_name, u.email)) ASC');
  });

  it('joins the assignment count only for sortBy=assigned, with an id tiebreaker', async () => {
    const { service, query, staff } = build();
    query.mockResolvedValue([]);
    query.mockResolvedValueOnce([{ total: 0 }]);
    staff.summarize.mockResolvedValue([]);

    await service.list(dto({ sortBy: 'assigned', sortDir: 'DESC' }));
    const pageSql = query.mock.calls[1][0];
    expect(pageSql).toContain('sales_clinic_assignments');
    expect(pageSql).not.toContain('sales_activities');
    expect(pageSql).toMatch(/ORDER BY COALESCE\(ac\.c, 0\) DESC NULLS LAST, u\.id DESC/);
  });

  it('filters by active state, and binds search as a parameter (never interpolated)', async () => {
    const { service, query, staff } = build();
    query.mockResolvedValue([]);
    query.mockResolvedValueOnce([{ total: 0 }]);
    staff.summarize.mockResolvedValue([]);

    await service.list(dto({ isActive: false, search: "o'brien%" }));
    const [countSql, countParams] = query.mock.calls[0];
    expect(countSql).toContain('u.is_active = $1');
    expect(countSql).not.toContain("o'brien");
    expect(countParams).toEqual([false, "%o'brien%%"]);
  });

  it('skips the stats query entirely for an empty page', async () => {
    const { service, query, staff } = build();
    query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    staff.summarize.mockResolvedValue([]);
    const res = await service.list(dto());
    expect(query).toHaveBeenCalledTimes(2);
    expect(res.data).toEqual([]);
  });
});

describe('SalesEmployeeService.overview', () => {
  it('returns counts, the parsed period and the billing mode in one SQL round trip', async () => {
    const { service, query, billingMode } = build();
    query.mockResolvedValueOnce([
      { employees: 5, active_employees: 4, assigned_clinics: 120, unassigned_clinics: 30 },
    ]);
    billingMode.get.mockResolvedValueOnce('FREE');

    const res = await service.overview('2026-09');

    expect(query).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      period: '2026-09',
      periodMonth: '2026-09-01',
      employees: 5,
      activeEmployees: 4,
      assignedClinics: 120,
      unassignedClinics: 30,
      billingMode: 'FREE',
      targetsSet: 0,
      onTrack: 0,
      byMetric: [],
      billingLive: false,
    });
  });

  const row = (over: Record<string, unknown>) => ({
    employeeId: 'e1',
    metric: 'new_clinics',
    period: '2026-09',
    target: 10,
    currency: null,
    achieved: 4,
    percentage: 40,
    isCompleted: false,
    onTrack: true,
    ...over,
  });

  it('aggregates targets per metric, and revenue per currency (no FX)', async () => {
    const { service, query, billingMode, progress } = build();
    query.mockResolvedValueOnce([
      { employees: 3, active_employees: 3, assigned_clinics: 0, unassigned_clinics: 0 },
    ]);
    billingMode.get.mockResolvedValueOnce('PAID');
    progress.rows.mockResolvedValueOnce([
      row({ employeeId: 'a', target: 10, achieved: 4, onTrack: true }),
      row({ employeeId: 'b', target: 20, achieved: 6, onTrack: false }),
      row({ employeeId: 'a', metric: 'subscription_revenue', currency: 'SAR', target: 1000, achieved: 250.5, onTrack: true }),
      row({ employeeId: 'b', metric: 'subscription_revenue', currency: 'USD', target: 500, achieved: 500, onTrack: true }),
    ]);

    const res = await service.overview('2026-09');

    expect(res.targetsSet).toBe(4);
    expect(res.onTrack).toBe(3);
    expect(res.byMetric).toEqual([
      { metric: 'new_clinics', currency: null, targets: 2, target: 30, achieved: 10, percentage: 33.33, onTrack: 1 },
      { metric: 'subscription_revenue', currency: 'SAR', targets: 1, target: 1000, achieved: 250.5, percentage: 25.05, onTrack: 1 },
      { metric: 'subscription_revenue', currency: 'USD', targets: 1, target: 500, achieved: 500, percentage: 100, onTrack: 1 },
    ]);
  });

  it('counts only targets of ACTIVE employees for an open month, and everyone for a closed one', async () => {
    const { service, query, billingMode, progress } = build();
    query.mockResolvedValue([
      { employees: 0, active_employees: 0, assigned_clinics: 0, unassigned_clinics: 0 },
    ]);
    billingMode.get.mockResolvedValue('FREE');

    const open = new Date();
    const openPeriod = `${open.getUTCFullYear()}-${String(open.getUTCMonth() + 1).padStart(2, '0')}`;
    await service.overview(openPeriod);
    expect(progress.loadTeamTargets.mock.calls[0][1]).toBe(true);

    await service.overview('2020-01');
    expect(progress.loadTeamTargets.mock.calls[1][1]).toBe(false);
  });

  it('reports billingLive only in PAID mode', async () => {
    const { service, query, billingMode } = build();
    query.mockResolvedValue([
      { employees: 0, active_employees: 0, assigned_clinics: 0, unassigned_clinics: 0 },
    ]);
    billingMode.get.mockResolvedValue('PAID');
    expect((await service.overview('2026-09')).billingLive).toBe(true);
  });

  it('rejects a malformed period before touching the database', async () => {
    const { service, query } = build();
    await expect(service.overview('2026-13')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('SalesEmployeeService.detail', () => {
  it('404s for a non-employee without loading anything else', async () => {
    const { service, query, staff } = build();
    query.mockResolvedValueOnce([]);
    await expect(service.detail('x')).rejects.toMatchObject({
      code: ErrorCode.SALES_EMPLOYEE_NOT_FOUND,
    });
    expect(staff.summarize).not.toHaveBeenCalled();
  });

  it('merges the staff summary with the portfolio stats', async () => {
    const { service, query, staff } = build();
    query
      .mockResolvedValueOnce([ROW]) // requireEmployee
      .mockResolvedValueOnce([
        { id: 'e1', assigned_count: 7, ended_count: 2, last_activity_at: null },
      ]);
    staff.summarize.mockResolvedValueOnce([{ id: 'e1', email: 'rep@x.io' }]);
    await expect(service.detail('e1')).resolves.toMatchObject({
      id: 'e1',
      assignedCount: 7,
      endedCount: 2,
      lastActivityAt: null,
    });
  });
});
