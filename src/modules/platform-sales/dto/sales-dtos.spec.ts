import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { AssignClinicsDto } from './assign-clinics.dto';
import { EndAssignmentsDto, TransferAssignmentsDto } from './end-assignments.dto';
import { QueryEmployeeClinicsDto } from './query-employee-clinics.dto';
import { QuerySalesClinicsDto } from './query-sales-clinics.dto';
import { QuerySalesEmployeesDto } from './query-sales-employees.dto';
import { SalesOverviewQueryDto } from './sales-overview-query.dto';

// Mirrors the global ValidationPipe in main.ts.
const check = <T extends object>(cls: new () => T, plain: object) => {
  const inst = plainToInstance(cls, plain, { enableImplicitConversion: true });
  const errors = validateSync(inst as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { inst, errors, fields: errors.map((e) => e.property) };
};

const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ids = (count: number) => Array.from({ length: count }, (_, i) => U(i + 1));

describe('AssignClinicsDto', () => {
  it('accepts 1..200 unique uuids', () => {
    expect(check(AssignClinicsDto, { tenantIds: ids(1) }).errors).toHaveLength(0);
    expect(check(AssignClinicsDto, { tenantIds: ids(200) }).errors).toHaveLength(0);
  });

  it.each([
    ['empty', []],
    ['201 ids', ids(201)],
    ['duplicates', [U(1), U(1)]],
    ['a non-uuid', ['not-a-uuid']],
  ])('rejects %s', (_label, tenantIds) => {
    expect(check(AssignClinicsDto, { tenantIds }).fields).toContain('tenantIds');
  });

  it('rejects a bad kind / onConflict and any unknown field (no mass assignment)', () => {
    expect(check(AssignClinicsDto, { tenantIds: ids(1), kind: 'owner' }).fields).toContain('kind');
    expect(check(AssignClinicsDto, { tenantIds: ids(1), onConflict: 'overwrite' }).fields).toContain('onConflict');
    expect(check(AssignClinicsDto, { tenantIds: ids(1), salesUserId: U(9) }).fields).toContain('salesUserId');
    expect(check(AssignClinicsDto, { tenantIds: ids(1), assignedBy: U(9) }).fields).toContain('assignedBy');
  });

  it('caps the note at 500 characters', () => {
    expect(check(AssignClinicsDto, { tenantIds: ids(1), note: 'x'.repeat(501) }).fields).toContain('note');
    expect(check(AssignClinicsDto, { tenantIds: ids(1), note: 'x'.repeat(500) }).errors).toHaveLength(0);
  });
});

describe('EndAssignmentsDto', () => {
  it('needs 1..200 unique uuids', () => {
    expect(check(EndAssignmentsDto, { assignmentIds: ids(3) }).errors).toHaveLength(0);
    expect(check(EndAssignmentsDto, { assignmentIds: [] }).fields).toContain('assignmentIds');
    expect(check(EndAssignmentsDto, { assignmentIds: ids(201) }).fields).toContain('assignmentIds');
  });
});

describe('TransferAssignmentsDto', () => {
  it('accepts a subset OR all=true', () => {
    expect(check(TransferAssignmentsDto, { toEmployeeId: U(1), assignmentIds: ids(2) }).errors).toHaveLength(0);
    expect(check(TransferAssignmentsDto, { toEmployeeId: U(1), all: true }).errors).toHaveLength(0);
  });

  it('rejects neither a subset nor all', () => {
    expect(check(TransferAssignmentsDto, { toEmployeeId: U(1) }).fields).toContain('assignmentIds');
    expect(check(TransferAssignmentsDto, { toEmployeeId: U(1), all: false }).fields).toContain('assignmentIds');
  });

  it('requires a valid target employee id', () => {
    expect(check(TransferAssignmentsDto, { toEmployeeId: 'x', all: true }).fields).toContain('toEmployeeId');
    expect(check(TransferAssignmentsDto, { all: true }).fields).toContain('toEmployeeId');
  });
});

describe('list query DTOs', () => {
  it('QuerySalesEmployeesDto defaults, and parses isActive=false as FALSE', () => {
    const { inst, errors } = check(QuerySalesEmployeesDto, { isActive: 'false' });
    expect(errors).toHaveLength(0);
    expect(inst.isActive).toBe(false);
    expect(inst).toMatchObject({ page: 1, limit: 20, sortBy: 'createdAt', sortDir: 'DESC' });
  });

  it('only allow-listed sort keys and directions are accepted (no SQL through sortBy)', () => {
    expect(check(QuerySalesEmployeesDto, { sortBy: 'assigned', sortDir: 'ASC' }).errors).toHaveLength(0);
    expect(check(QuerySalesEmployeesDto, { sortBy: 'u.id; DROP TABLE users' }).fields).toContain('sortBy');
    expect(check(QuerySalesEmployeesDto, { sortDir: 'asc; --' }).fields).toContain('sortDir');
    expect(check(QuerySalesClinicsDto, { sortBy: 'password_hash' }).fields).toContain('sortBy');
    expect(check(QueryEmployeeClinicsDto, { sortBy: 'ended_by' }).fields).toContain('sortBy');
  });

  it('bounds page and limit', () => {
    expect(check(QuerySalesEmployeesDto, { limit: 101 }).fields).toContain('limit');
    expect(check(QuerySalesEmployeesDto, { limit: 0 }).fields).toContain('limit');
    expect(check(QuerySalesEmployeesDto, { page: 0 }).fields).toContain('page');
  });

  it('QuerySalesClinicsDto defaults to unassigned and validates the enums/uuid', () => {
    expect(check(QuerySalesClinicsDto, {}).inst.assignment).toBe('unassigned');
    expect(check(QuerySalesClinicsDto, { assignment: 'mine' }).fields).toContain('assignment');
    expect(check(QuerySalesClinicsDto, { approvalStatus: 'NOPE' }).fields).toContain('approvalStatus');
    expect(check(QuerySalesClinicsDto, { excludeEmployeeId: 'x' }).fields).toContain('excludeEmployeeId');
    expect(check(QuerySalesClinicsDto, { excludeEmployeeId: U(1) }).errors).toHaveLength(0);
  });

  it('QueryEmployeeClinicsDto defaults to active and bounds staleDays', () => {
    expect(check(QueryEmployeeClinicsDto, {}).inst).toMatchObject({ status: 'active', sortBy: 'assignedAt' });
    expect(check(QueryEmployeeClinicsDto, { staleDays: 0 }).fields).toContain('staleDays');
    expect(check(QueryEmployeeClinicsDto, { staleDays: 3651 }).fields).toContain('staleDays');
    expect(check(QueryEmployeeClinicsDto, { staleDays: 30, status: 'all', kind: 'acquired' }).errors).toHaveLength(0);
    expect(check(QueryEmployeeClinicsDto, { kind: 'x' }).fields).toContain('kind');
  });

  it('SalesOverviewQueryDto accepts YYYY-MM only', () => {
    expect(check(SalesOverviewQueryDto, { period: '2026-09' }).errors).toHaveLength(0);
    expect(check(SalesOverviewQueryDto, {}).errors).toHaveLength(0);
    for (const bad of ['2026-13', '2026-9', '2026-09-01', 'x']) {
      expect(check(SalesOverviewQueryDto, { period: bad }).fields).toContain('period');
    }
  });
});
