import ExcelJS from 'exceljs';

import { AppError, ErrorCode } from '../../common/errors';
import type { UploadedFileLike } from '../storage/uploads.controller';
import { PLATFORM_ADMIN_AUDIT_ACTION } from '../platform/platform-admin-audit.service';
import { SalesAssignmentImportService } from './sales-assignment-import.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EMP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const tid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  approval_status: string;
}
const tenant = (n: number, approval_status = 'APPROVED'): TenantRow => ({
  id: tid(n),
  name: `Clinic ${n}`,
  slug: `clinic-${n}`,
  approval_status,
});

async function xlsxFile(
  rows: Array<Array<string | undefined>>,
  overrides: Partial<UploadedFileLike> = {},
): Promise<UploadedFileLike> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Assignments');
  for (const r of rows) ws.addRow(r);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return {
    originalname: 'assignments.xlsx',
    mimetype: XLSX,
    size: buffer.length,
    buffer,
    ...overrides,
  };
}

const HEADER = ['clinic_slug', 'clinic_id', 'kind', 'note'];

interface World {
  tenants?: TenantRow[];
  owners?: Array<{ tenant_id: string; sales_user_id: string; name: string | null }>;
  credited?: string[];
}

function build(world: World = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/FROM tenants\s+WHERE deleted_at IS NULL/.test(sql)) {
      const [slugs, ids] = params as [string[], string[]];
      return (world.tenants ?? []).filter(
        (t) => slugs.includes(t.slug) || ids.includes(t.id),
      );
    }
    if (/a\.ended_at IS NULL/.test(sql) && /LEFT JOIN users/.test(sql)) return world.owners ?? [];
    if (/kind = 'acquired'/.test(sql)) return (world.credited ?? []).map((tenant_id) => ({ tenant_id }));
    throw new Error(`unscripted query: ${sql.slice(0, 100)}`);
  });
  const manager = { query } as any;
  const dataSource = {
    query,
    transaction: jest.fn(async (cb: (m: any) => unknown) => cb(manager)),
  } as any;
  const employees = {
    requireEmployee: jest.fn().mockResolvedValue({ id: EMP, isActive: true }),
  } as any;
  const assignments = {
    assignBatch: jest.fn(async (_m: unknown, p: { items: Array<{ tenantId: string }> }) => ({
      result: { requested: p.items.length, assigned: p.items.length, reassigned: 0, skipped: [] },
      previousOwners: {},
    })),
  } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const service = new SalesAssignmentImportService(dataSource, employees, assignments, audit);
  return { service, calls, query, employees, assignments, audit, dataSource };
}

describe('SalesAssignmentImportService.preview', () => {
  it('classifies every row and totals them; writes nothing', async () => {
    const { service, assignments, audit } = build({
      tenants: [tenant(1), tenant(2), tenant(3), tenant(4, 'REJECTED')],
      owners: [
        { tenant_id: tid(2), sales_user_id: EMP, name: 'Me' },
        { tenant_id: tid(3), sales_user_id: OTHER, name: 'Omar' },
      ],
    });
    const file = await xlsxFile([
      HEADER,
      ['clinic-1'],
      ['clinic-2'],
      ['clinic-3'],
      ['clinic-4'],
      ['ghost'],
      ['clinic-1'],
      ['Bad Slug!'],
      ['clinic-1', tid(2)],
    ]);

    const res = await service.preview(EMP, file, {});

    expect(res.totalRows).toBe(8);
    expect(res.rows.map((r) => r.status)).toEqual([
      'will_assign',
      'already_yours',
      'assigned_to_other',
      'clinic_rejected',
      'not_found',
      'duplicate_in_file',
      'invalid_identifier',
      'slug_id_mismatch', // resolution is checked before the duplicate rule
    ]);
    expect(res.counts.will_assign).toBe(1);
    expect(res.willApply).toBe(1);
    expect(res.rows[0].row).toBe(2);
    expect(res.rows[2].owner).toEqual({ employeeId: OTHER, name: 'Omar' });
    expect(assignments.assignBatch).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('onConflict=reassign turns another employee\'s clinic into will_reassign', async () => {
    const { service } = build({
      tenants: [tenant(3)],
      owners: [{ tenant_id: tid(3), sales_user_id: OTHER, name: 'Omar' }],
    });
    const res = await service.preview(EMP, await xlsxFile([HEADER, ['clinic-3']]), { onConflict: 'reassign' });
    expect(res.rows[0].status).toBe('will_reassign');
    expect(res.willApply).toBe(1);
  });

  it('defaultKind applies to blank kind cells; an explicit cell wins', async () => {
    const { service } = build({ tenants: [tenant(1), tenant(2)] });
    const res = await service.preview(
      EMP,
      await xlsxFile([HEADER, ['clinic-1'], ['clinic-2', '', 'managed']]),
      { defaultKind: 'acquired' },
    );
    expect(res.rows.map((r) => r.kind)).toEqual(['acquired', 'managed']);
  });

  it('flags an acquired row for an already-credited clinic', async () => {
    const { service } = build({ tenants: [tenant(1)], credited: [tid(1)] });
    const res = await service.preview(EMP, await xlsxFile([HEADER, ['clinic-1', '', 'acquired']]), {});
    expect(res.rows[0].status).toBe('acquisition_already_credited');
  });

  it('skips the acquisition-credit lookup when no row is acquired', async () => {
    const { service, calls } = build({ tenants: [tenant(1)] });
    await service.preview(EMP, await xlsxFile([HEADER, ['clinic-1']]), {});
    expect(calls.some((c) => /kind = 'acquired'/.test(c.sql))).toBe(false);
  });

  it('runs a constant number of queries however many rows the file has', async () => {
    const few = build({ tenants: [tenant(1)] });
    await few.service.preview(EMP, await xlsxFile([HEADER, ['clinic-1']]), {});

    const manyTenants = Array.from({ length: 300 }, (_, i) => tenant(i + 1));
    const many = build({ tenants: manyTenants });
    await many.service.preview(
      EMP,
      await xlsxFile([HEADER, ...manyTenants.map((t) => [t.slug])]),
      {},
    );
    expect(many.query.mock.calls.length).toBe(few.query.mock.calls.length);
  });

  it('accepts a file with only a clinic_id column', async () => {
    const { service } = build({ tenants: [tenant(1)] });
    const res = await service.preview(EMP, await xlsxFile([['clinic_id'], [tid(1)]]), {});
    expect(res.rows[0]).toMatchObject({ status: 'will_assign', identifier: tid(1) });
  });

  it('accepts header aliases in any case', async () => {
    const { service } = build({ tenants: [tenant(1)] });
    const res = await service.preview(EMP, await xlsxFile([['Clinic Slug', 'NOTES'], ['clinic-1', 'hi']]), {});
    expect(res.rows[0]).toMatchObject({ status: 'will_assign', note: 'hi' });
  });

  describe('refusals', () => {
    it('rejects an inactive employee before reading the file', async () => {
      const { service, employees, query } = build();
      employees.requireEmployee.mockRejectedValue(new AppError(ErrorCode.SALES_EMPLOYEE_INACTIVE));
      await expect(service.preview(EMP, await xlsxFile([HEADER, ['a']]), {})).rejects.toMatchObject({
        code: ErrorCode.SALES_EMPLOYEE_INACTIVE,
      });
      expect(employees.requireEmployee).toHaveBeenCalledWith(EMP, { requireActive: true });
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects a missing file', async () => {
      const { service } = build();
      await expect(service.preview(EMP, undefined, {})).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    });

    it('rejects a non-xlsx extension and spoofed content', async () => {
      const { service } = build();
      const good = await xlsxFile([HEADER, ['a']]);
      await expect(service.preview(EMP, { ...good, originalname: 'a.csv' }, {})).rejects.toMatchObject({
        code: ErrorCode.UNSUPPORTED_FILE_TYPE,
      });
      await expect(
        service.preview(EMP, { ...good, buffer: Buffer.from('not a zip at all'), size: 16 }, {}),
      ).rejects.toBeDefined();
    });

    it('rejects a file over 5 MB', async () => {
      const { service } = build();
      const good = await xlsxFile([HEADER, ['a']]);
      await expect(
        service.preview(EMP, { ...good, size: 5 * 1024 * 1024 + 1 }, {}),
      ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });
    });

    it('rejects a file with neither clinic_slug nor clinic_id', async () => {
      const { service } = build();
      await expect(
        service.preview(EMP, await xlsxFile([['kind', 'note'], ['managed', 'x']]), {}),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('rejects a file with no data rows', async () => {
      const { service } = build();
      await expect(service.preview(EMP, await xlsxFile([HEADER]), {})).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    });

    it('rejects more than 2,000 data rows, accepts exactly 2,000', async () => {
      const { service } = build();
      const rows = (n: number) => [HEADER, ...Array.from({ length: n }, (_, i) => [`c-${i}`])];
      await expect(service.preview(EMP, await xlsxFile(rows(2001)), {})).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
      const ok = await service.preview(EMP, await xlsxFile(rows(2000)), {});
      expect(ok.totalRows).toBe(2000);
    }, 30_000);
  });
});

describe('SalesAssignmentImportService.commit', () => {
  it('re-validates in its own transaction and applies only the applicable rows, with per-row kind and note', async () => {
    const { service, assignments, employees, dataSource } = build({
      tenants: [tenant(1), tenant(2), tenant(3)],
      owners: [{ tenant_id: tid(3), sales_user_id: OTHER, name: 'Omar' }],
    });
    const file = await xlsxFile([
      HEADER,
      ['clinic-1', '', 'acquired', 'brought in'],
      ['clinic-2', '', 'managed'],
      ['clinic-3'],
      ['ghost'],
    ]);

    const res = await service.commit(EMP, file, {}, ACTOR);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(employees.requireEmployee).toHaveBeenCalledWith(EMP, {
      manager: expect.anything(),
      requireActive: true,
    });
    expect(assignments.assignBatch).toHaveBeenCalledTimes(1);
    expect(assignments.assignBatch.mock.calls[0][1]).toEqual({
      employeeId: EMP,
      items: [
        { tenantId: tid(1), kind: 'acquired', note: 'brought in' },
        { tenantId: tid(2), kind: 'managed', note: null },
      ],
      onConflict: 'skip',
      actorUserId: ACTOR,
    });
    expect(res).toMatchObject({ totalRows: 4, assigned: 2, reassigned: 0, alreadyYours: 0, skipped: 2 });
    expect(res.errors.map((e) => [e.row, e.status])).toEqual([
      [4, 'assigned_to_other'],
      [5, 'not_found'],
    ]);
  });

  it('never trusts the file for the employee: rows go to the path employee, whatever the file says', async () => {
    const { service, assignments } = build({ tenants: [tenant(1)] });
    const file = await xlsxFile([[...HEADER, 'employee_id'], ['clinic-1', '', '', '', OTHER]]);
    await service.commit(EMP, file, {}, ACTOR);
    expect(assignments.assignBatch.mock.calls[0][1].employeeId).toBe(EMP);
  });

  it('counts already_yours as a no-op, not an error, and does not call the write when nothing applies', async () => {
    const { service, assignments, audit } = build({
      tenants: [tenant(1)],
      owners: [{ tenant_id: tid(1), sales_user_id: EMP, name: 'Me' }],
    });
    const res = await service.commit(EMP, await xlsxFile([HEADER, ['clinic-1']]), {}, ACTOR);
    expect(res).toEqual({ totalRows: 1, assigned: 0, reassigned: 0, alreadyYours: 1, skipped: 0, errors: [] });
    expect(assignments.assignBatch).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reports a write-time race loser as concurrent_assignment and does not audit it as assigned', async () => {
    const { service, assignments, audit } = build({ tenants: [tenant(1), tenant(2)] });
    assignments.assignBatch.mockResolvedValue({
      result: {
        requested: 2,
        assigned: 1,
        reassigned: 0,
        skipped: [{ tenantId: tid(2), reason: 'concurrent_assignment' }],
      },
      previousOwners: {},
    });
    const res = await service.commit(EMP, await xlsxFile([HEADER, ['clinic-1'], ['clinic-2']]), {}, ACTOR);
    expect(res.assigned).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ row: 3, status: 'concurrent_assignment' });
    expect(audit.record.mock.calls[0][0].after.tenantIds).toEqual([tid(1)]);
  });

  it('maps every other write-time skip onto a row status', async () => {
    const { service, assignments } = build({ tenants: [tenant(1), tenant(2), tenant(3)] });
    assignments.assignBatch.mockResolvedValue({
      result: {
        requested: 3,
        assigned: 0,
        reassigned: 0,
        skipped: [
          { tenantId: tid(1), reason: 'assigned_to_other' },
          { tenantId: tid(2), reason: 'acquisition_already_credited' },
          { tenantId: tid(3), reason: 'already_assigned_to_employee' },
        ],
      },
      previousOwners: {},
    });
    const res = await service.commit(
      EMP,
      await xlsxFile([HEADER, ['clinic-1'], ['clinic-2'], ['clinic-3']]),
      {},
      ACTOR,
    );
    expect(res.errors.map((e) => e.status)).toEqual(['assigned_to_other', 'acquisition_already_credited']);
    expect(res.alreadyYours).toBe(1);
  });

  it('audits ONE import_committed entry with counts and at most 200 tenant ids', async () => {
    const tenants = Array.from({ length: 250 }, (_, i) => tenant(i + 1));
    const { service, audit, assignments } = build({ tenants });
    assignments.assignBatch.mockImplementation(async (_m: unknown, p: any) => ({
      result: { requested: p.items.length, assigned: p.items.length, reassigned: 0, skipped: [] },
      previousOwners: {},
    }));
    await service.commit(EMP, await xlsxFile([HEADER, ...tenants.map((t) => [t.slug])]), {}, ACTOR);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_IMPORT_COMMITTED,
      userId: ACTOR,
      entityType: 'SalesEmployee',
      entityId: EMP,
    });
    expect(entry.after).toMatchObject({ totalRows: 250, assigned: 250, skipped: 0, onConflict: 'skip' });
    expect(entry.after.tenantIds).toHaveLength(200);
  });

  it('records who was displaced when reassigning', async () => {
    const { service, audit, assignments } = build({
      tenants: [tenant(3)],
      owners: [{ tenant_id: tid(3), sales_user_id: OTHER, name: 'Omar' }],
    });
    assignments.assignBatch.mockResolvedValue({
      result: { requested: 1, assigned: 1, reassigned: 1, skipped: [] },
      previousOwners: { [tid(3)]: OTHER },
    });
    const res = await service.commit(EMP, await xlsxFile([HEADER, ['clinic-3']]), { onConflict: 'reassign' }, ACTOR);
    expect(res).toMatchObject({ assigned: 1, reassigned: 1 });
    expect(audit.record.mock.calls[0][0].before).toEqual({ previousOwnerEmployeeIds: [OTHER] });
    expect(assignments.assignBatch.mock.calls[0][1].onConflict).toBe('reassign');
  });

  it('turns a unique violation (the acquired-credit race) into SALES_CLINIC_ALREADY_ASSIGNED', async () => {
    const { service, assignments } = build({ tenants: [tenant(1)] });
    assignments.assignBatch.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(
      service.commit(EMP, await xlsxFile([HEADER, ['clinic-1', '', 'acquired']]), {}, ACTOR),
    ).rejects.toMatchObject({ code: ErrorCode.SALES_CLINIC_ALREADY_ASSIGNED });
  });

  it('refuses an inactive employee and writes nothing', async () => {
    const { service, employees, assignments } = build({ tenants: [tenant(1)] });
    employees.requireEmployee.mockRejectedValue(new AppError(ErrorCode.SALES_EMPLOYEE_INACTIVE));
    await expect(service.commit(EMP, await xlsxFile([HEADER, ['clinic-1']]), {}, ACTOR)).rejects.toMatchObject({
      code: ErrorCode.SALES_EMPLOYEE_INACTIVE,
    });
    expect(assignments.assignBatch).not.toHaveBeenCalled();
  });
});

describe('SalesAssignmentImportService.buildTemplate', () => {
  it('produces a workbook whose header row is importable and has an instructions sheet', async () => {
    const { service } = build({ tenants: [tenant(1)] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await service.buildTemplate()) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Assignments', 'Instructions']);
    expect((wb.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual([
      'clinic_slug',
      'clinic_id',
      'kind',
      'note',
    ]);
    // The template itself parses (its example row is a harmless not_found).
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await service.preview(
      EMP,
      { originalname: 't.xlsx', mimetype: XLSX, size: buf.length, buffer: buf },
      {},
    );
    expect(res.rows[0].status).toBe('not_found');
  });
});

describe('SalesAssignmentImportService.exportAssignments', () => {
  const dbRow = (n: number, over: Record<string, unknown> = {}) => ({
    id: tid(1000 + n),
    kind: 'managed',
    note: null,
    assigned_at: new Date('2026-05-01T10:00:00.000Z'),
    ended_at: null,
    end_reason: null,
    assigned_key: `2026-05-01 10:00:00.${String(n).padStart(6, '0')}+00`,
    tenant_id: tid(n),
    slug: `clinic-${n}`,
    name: `Clinic ${n}`,
    approval_status: 'APPROVED',
    email: 'rep@ziyara.test',
    full_name: 'Rania Rep',
    ...over,
  });

  function exportWorld(rows: Array<ReturnType<typeof dbRow>>) {
    const b = build();
    b.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      b.calls.push({ sql, params });
      if (!/FROM sales_clinic_assignments a/.test(sql)) throw new Error('unscripted');
      // Emulate the keyset: rows are already ordered; skip everything <= cursor.
      const limit = params[params.length - 1] as number;
      const hasCursor = /\(t\.slug, a\.assigned_at, a\.id\) >/.test(sql);
      let start = 0;
      if (hasCursor) {
        const lastId = params[params.length - 2] as string;
        start = rows.findIndex((r) => r.id === lastId) + 1;
      }
      return rows.slice(start, start + limit);
    });
    return b;
  }

  const readSheet = async (buffer: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.worksheets[0];
    const header = (ws.getRow(1).values as unknown[]).slice(1) as string[];
    const rows: Array<Record<string, unknown>> = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const values = (ws.getRow(r).values as unknown[]).slice(1);
      rows.push(Object.fromEntries(header.map((h, i) => [h, values[i]])));
    }
    return { header, rows };
  };

  it('writes the import headers first, then the reporting columns', async () => {
    const { service } = exportWorld([dbRow(1)]);
    const { buffer, rowCount } = await service.exportAssignments({});
    const { header, rows } = await readSheet(buffer);
    expect(rowCount).toBe(1);
    expect(header.slice(0, 4)).toEqual(['clinic_slug', 'clinic_id', 'kind', 'note']);
    expect(rows[0]).toMatchObject({
      clinic_slug: 'clinic-1',
      clinic_id: tid(1),
      kind: 'managed',
      clinic_name: 'Clinic 1',
      employee_email: 'rep@ziyara.test',
      assignment_status: 'active',
      assigned_at: '2026-05-01T10:00:00.000Z',
    });
  });

  it('pages by keyset — every row exactly once, one page in flight — and stops on a short page', async () => {
    const all = [1, 2, 3, 4, 5].map((n) => dbRow(n));
    const { service, calls } = exportWorld(all);
    const { buffer, rowCount } = await service.exportAssignments({}, 2);
    expect(rowCount).toBe(5);
    const { rows } = await readSheet(buffer);
    expect(rows.map((r) => r.clinic_slug)).toEqual(['clinic-1', 'clinic-2', 'clinic-3', 'clinic-4', 'clinic-5']);
    expect(calls).toHaveLength(3); // 2 + 2 + 1
    expect(calls[1].params).toEqual(['clinic-2', all[1].assigned_key, all[1].id, 2]);
  });

  it('an empty export still has its header row', async () => {
    const { service } = exportWorld([]);
    const { buffer, rowCount } = await service.exportAssignments({});
    const { header, rows } = await readSheet(buffer);
    expect(rowCount).toBe(0);
    expect(header).toHaveLength(12);
    expect(rows).toEqual([]);
  });

  it('escapes formula-like text in every cell (SEC-05) but leaves stored data untouched', async () => {
    const { service } = exportWorld([
      dbRow(1, { name: '=HYPERLINK("http://evil","x")', note: '@SUM(A1)', full_name: '-2+3', email: '+cmd|calc' }),
    ]);
    const { buffer } = await service.exportAssignments({});
    const { rows } = await readSheet(buffer);
    expect(rows[0].clinic_name).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(rows[0].note).toBe(`'@SUM(A1)`);
    expect(rows[0].employee_name).toBe(`'-2+3`);
    expect(rows[0].employee_email).toBe(`'+cmd|calc`);
  });

  it('filters by employee and status in SQL, never by string-building user input', async () => {
    const { service, calls, employees } = exportWorld([]);
    await service.exportAssignments({ employeeId: EMP, status: 'ended' });
    expect(employees.requireEmployee).toHaveBeenCalledWith(EMP);
    expect(calls[0].sql).toMatch(/a\.sales_user_id = \$1::uuid/);
    expect(calls[0].sql).toMatch(/a\.ended_at IS NOT NULL/);
    expect(calls[0].sql).not.toContain(EMP);
    expect(calls[0].params[0]).toBe(EMP);
  });

  it('defaults to active assignments and to every employee', async () => {
    const { service, calls, employees } = exportWorld([]);
    await service.exportAssignments({});
    expect(employees.requireEmployee).not.toHaveBeenCalled();
    expect(calls[0].sql).toMatch(/a\.ended_at IS NULL/);
    expect(calls[0].sql).not.toMatch(/a\.sales_user_id = /);
    expect(calls[0].sql).toMatch(/t\.deleted_at IS NULL/);
  });

  it('404s for an employee id that is not a sales employee', async () => {
    const { service, employees } = exportWorld([]);
    employees.requireEmployee.mockRejectedValue(new AppError(ErrorCode.SALES_EMPLOYEE_NOT_FOUND));
    await expect(service.exportAssignments({ employeeId: EMP })).rejects.toMatchObject({
      code: ErrorCode.SALES_EMPLOYEE_NOT_FOUND,
    });
  });
});
