import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { QuerySalesEmployeesDto } from './query-sales-employees.dto';
import {
  DeleteSalesTargetQueryDto,
  QuerySalesTargetsDto,
} from './query-sales-targets.dto';
import { QueryTargetRevisionsDto } from './query-target-revisions.dto';
import { SetSalesTargetDto } from './set-sales-target.dto';

// Mirrors the global ValidationPipe in main.ts.
const check = <T extends object>(cls: new () => T, plain: object) => {
  const inst = plainToInstance(cls, plain, { enableImplicitConversion: true });
  const errors = validateSync(inst as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { inst, errors, fields: errors.map((e) => e.property) };
};

describe('QuerySalesEmployeesDto.period', () => {
  it('accepts YYYY-MM and rejects anything else', () => {
    expect(check(QuerySalesEmployeesDto, { period: '2026-09' }).errors).toHaveLength(0);
    for (const bad of ['2026-9', '2026-13', '2026-00', 'sept', '2026-09-01', '']) {
      expect(check(QuerySalesEmployeesDto, { period: bad }).fields).toContain('period');
    }
  });
  it('is optional', () => {
    expect(check(QuerySalesEmployeesDto, {}).errors).toHaveLength(0);
  });
});

describe('QuerySalesTargetsDto', () => {
  it('takes optional from / to months', () => {
    expect(check(QuerySalesTargetsDto, {}).errors).toHaveLength(0);
    expect(check(QuerySalesTargetsDto, { from: '2026-01', to: '2026-12' }).errors).toHaveLength(0);
    expect(check(QuerySalesTargetsDto, { from: '2026-1' }).fields).toContain('from');
    expect(check(QuerySalesTargetsDto, { to: '20-13' }).fields).toContain('to');
  });
  it('refuses unknown params', () => {
    expect(check(QuerySalesTargetsDto, { employeeId: 'x' }).fields).toContain('employeeId');
  });
});

describe('DeleteSalesTargetQueryDto', () => {
  it('caps the reason at 500 characters', () => {
    expect(check(DeleteSalesTargetQueryDto, { reason: 'x'.repeat(500) }).errors).toHaveLength(0);
    expect(check(DeleteSalesTargetQueryDto, { reason: 'x'.repeat(501) }).fields).toContain('reason');
  });
});

describe('QueryTargetRevisionsDto', () => {
  it('filters by month and metric, with paging', () => {
    expect(
      check(QueryTargetRevisionsDto, { period: '2026-09', metric: 'new_clinics', page: '2', limit: '10' }).errors,
    ).toHaveLength(0);
    expect(check(QueryTargetRevisionsDto, { metric: 'headcount' }).fields).toContain('metric');
    expect(check(QueryTargetRevisionsDto, { period: '2026-9' }).fields).toContain('period');
    expect(check(QueryTargetRevisionsDto, { limit: '101' }).fields).toContain('limit');
  });
});

describe('SetSalesTargetDto', () => {
  it('needs only a target value', () => {
    expect(check(SetSalesTargetDto, { targetValue: 5 }).errors).toHaveLength(0);
    expect(check(SetSalesTargetDto, {}).fields).toContain('targetValue');
  });

  it('bounds the value: no negatives, no more than cents, nothing past numeric(14,2)', () => {
    expect(check(SetSalesTargetDto, { targetValue: -1 }).fields).toContain('targetValue');
    expect(check(SetSalesTargetDto, { targetValue: 1.234 }).fields).toContain('targetValue');
    expect(check(SetSalesTargetDto, { targetValue: 1e13 }).fields).toContain('targetValue');
    expect(check(SetSalesTargetDto, { targetValue: 0 }).errors).toHaveLength(0);
    expect(check(SetSalesTargetDto, { targetValue: 999_999_999_999.99 }).errors).toHaveLength(0);
  });

  it('accepts numeric strings (query-style) but not non-numbers', () => {
    expect(check(SetSalesTargetDto, { targetValue: '12' }).inst.targetValue).toBe(12);
    expect(check(SetSalesTargetDto, { targetValue: 'abc' }).fields).toContain('targetValue');
  });

  it('validates the bonus type and the currency codes', () => {
    expect(check(SetSalesTargetDto, { targetValue: 1, bonusType: 'lottery' }).fields).toContain('bonusType');
    expect(check(SetSalesTargetDto, { targetValue: 1, currency: 'SAUDI' }).fields).toContain('currency');
    expect(check(SetSalesTargetDto, { targetValue: 1, bonusCurrency: 'us' }).fields).toContain('bonusCurrency');
  });

  it('expectedVersion is a positive integer', () => {
    expect(check(SetSalesTargetDto, { targetValue: 1, expectedVersion: 2 }).errors).toHaveLength(0);
    expect(check(SetSalesTargetDto, { targetValue: 1, expectedVersion: 0 }).fields).toContain('expectedVersion');
    expect(check(SetSalesTargetDto, { targetValue: 1, expectedVersion: 1.5 }).fields).toContain('expectedVersion');
  });

  it('caps the reason at 500 characters', () => {
    expect(check(SetSalesTargetDto, { targetValue: 1, reason: 'x'.repeat(501) }).fields).toContain('reason');
  });

  it('refuses any field the client should never send (achieved value, paid bonus, ids)', () => {
    for (const extra of ['achieved', 'bonusPaid', 'salesUserId', 'periodMonth', 'version']) {
      expect(check(SetSalesTargetDto, { targetValue: 1, [extra]: 1 }).fields).toContain(extra);
    }
  });
});
