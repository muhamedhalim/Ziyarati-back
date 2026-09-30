import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  CreateSalesActivityDto,
  QuerySalesActivitiesDto,
} from './sales-activity-dtos';
import {
  ApproveSalesBonusDto,
  QueryBonusPreviewDto,
  QuerySalesBonusesDto,
  VoidSalesBonusDto,
} from './sales-bonus-dtos';

// Mirrors the global ValidationPipe in main.ts.
const check = <T extends object>(cls: new () => T, plain: object) => {
  const inst = plainToInstance(cls, plain, { enableImplicitConversion: true });
  const errors = validateSync(inst as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { inst, errors, fields: errors.map((e) => e.property) };
};

const UUID = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('ApproveSalesBonusDto — the client can never name an amount', () => {
  it('accepts an empty body or just the target version', () => {
    expect(check(ApproveSalesBonusDto, {}).errors).toHaveLength(0);
    expect(check(ApproveSalesBonusDto, { expectedVersion: 3 }).errors).toHaveLength(0);
  });

  it('rejects every field that could carry an amount or a status', () => {
    for (const field of ['amount', 'bonusAmount', 'bonus_amount', 'achieved', 'achievedValue', 'status', 'currency']) {
      expect(check(ApproveSalesBonusDto, { [field]: 1 }).fields).toContain(field);
    }
  });

  it('expectedVersion must be a positive whole number', () => {
    expect(check(ApproveSalesBonusDto, { expectedVersion: 0 }).fields).toContain('expectedVersion');
    expect(check(ApproveSalesBonusDto, { expectedVersion: 1.5 }).fields).toContain('expectedVersion');
  });
});

describe('VoidSalesBonusDto', () => {
  it('caps the reason at 500 characters and refuses other fields', () => {
    expect(check(VoidSalesBonusDto, { reason: 'x'.repeat(500) }).errors).toHaveLength(0);
    expect(check(VoidSalesBonusDto, { reason: 'x'.repeat(501) }).fields).toContain('reason');
    expect(check(VoidSalesBonusDto, { status: 'approved' }).fields).toContain('status');
  });
});

describe('QueryBonusPreviewDto / QuerySalesBonusesDto', () => {
  it('period is YYYY-MM', () => {
    expect(check(QueryBonusPreviewDto, { period: '2026-09' }).errors).toHaveLength(0);
    expect(check(QueryBonusPreviewDto, {}).errors).toHaveLength(0);
    for (const bad of ['2026-9', '2026-13', '2026-09-01', 'sept']) {
      expect(check(QueryBonusPreviewDto, { period: bad }).fields).toContain('period');
      expect(check(QuerySalesBonusesDto, { period: bad }).fields).toContain('period');
    }
  });

  it('status is one of approved | paid | void; paging is bounded', () => {
    for (const ok of ['approved', 'paid', 'void']) {
      expect(check(QuerySalesBonusesDto, { status: ok }).errors).toHaveLength(0);
    }
    expect(check(QuerySalesBonusesDto, { status: 'draft' }).fields).toContain('status');
    expect(check(QuerySalesBonusesDto, { limit: 101 }).fields).toContain('limit');
    expect(check(QuerySalesBonusesDto, { page: 0 }).fields).toContain('page');
  });
});

describe('CreateSalesActivityDto', () => {
  const ok = { type: 'visit', occurredAt: '2026-09-28T09:30:00.000Z', prospectName: 'Al Noor' };

  it('accepts a prospect activity and a clinic activity', () => {
    expect(check(CreateSalesActivityDto, ok).errors).toHaveLength(0);
    expect(
      check(CreateSalesActivityDto, { type: 'demo', occurredAt: '2026-09-28T09:30:00Z', tenantId: UUID, outcome: 'signed_up', note: 'ok' })
        .errors,
    ).toHaveLength(0);
  });

  it('type and outcome come from the fixed lists', () => {
    expect(check(CreateSalesActivityDto, { ...ok, type: 'lunch' }).fields).toContain('type');
    expect(check(CreateSalesActivityDto, { ...ok, outcome: 'maybe' }).fields).toContain('outcome');
    for (const t of ['visit', 'call', 'meeting', 'demo', 'follow_up']) {
      expect(check(CreateSalesActivityDto, { ...ok, type: t }).errors).toHaveLength(0);
    }
  });

  it('occurredAt must be a full ISO-8601 timestamp', () => {
    // A bare date and a zone-less time are refused: the server would read them in ITS local zone.
    for (const bad of ['yesterday', '2026-09-28', '28/09/2026', '2026-13-40T00:00:00Z', '', '2026-09-28T09:30:00', '2026-09-28T09:30']) {
      expect(check(CreateSalesActivityDto, { ...ok, occurredAt: bad }).fields).toContain('occurredAt');
    }
    for (const good of ['2026-09-28T09:30:00Z', '2026-09-28T09:30:00.123Z', '2026-09-28T12:30:00+03:00', '2026-09-28T09:30Z']) {
      expect(check(CreateSalesActivityDto, { ...ok, occurredAt: good }).errors).toHaveLength(0);
    }
    expect(check(CreateSalesActivityDto, { type: 'visit', prospectName: 'x' }).fields).toContain('occurredAt');
  });

  it('tenantId must be a uuid; the text fields are length-capped', () => {
    expect(check(CreateSalesActivityDto, { ...ok, prospectName: undefined, tenantId: 'not-a-uuid' }).fields).toContain('tenantId');
    expect(check(CreateSalesActivityDto, { ...ok, prospectName: 'x'.repeat(201) }).fields).toContain('prospectName');
    expect(check(CreateSalesActivityDto, { ...ok, note: 'x'.repeat(1001) }).fields).toContain('note');
    expect(check(CreateSalesActivityDto, { ...ok, note: 'x'.repeat(1000) }).errors).toHaveLength(0);
  });

  it('the server owns source, recordedBy and the employee — the client cannot send them', () => {
    for (const field of ['source', 'recordedBy', 'recorded_by', 'salesUserId', 'employeeId']) {
      expect(check(CreateSalesActivityDto, { ...ok, [field]: 'x' }).fields).toContain(field);
    }
  });
});

describe('QuerySalesActivitiesDto', () => {
  it('from / to are calendar days', () => {
    expect(check(QuerySalesActivitiesDto, { from: '2026-09-01', to: '2026-09-30' }).errors).toHaveLength(0);
    for (const bad of ['2026-9-1', '2026-09', '2026-09-01T00:00:00Z', 'today']) {
      expect(check(QuerySalesActivitiesDto, { from: bad }).fields).toContain('from');
      expect(check(QuerySalesActivitiesDto, { to: bad }).fields).toContain('to');
    }
  });

  it('type and tenantId are validated; paging is bounded', () => {
    expect(check(QuerySalesActivitiesDto, { type: 'call', tenantId: UUID }).errors).toHaveLength(0);
    expect(check(QuerySalesActivitiesDto, { type: 'nap' }).fields).toContain('type');
    expect(check(QuerySalesActivitiesDto, { tenantId: 'x' }).fields).toContain('tenantId');
    expect(check(QuerySalesActivitiesDto, { limit: 500 }).fields).toContain('limit');
  });
});
