import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { ErrorCode } from '../../common/errors';
import {
  createMockDataSource,
  createMockRepository,
  MockDataSource,
  MockRepository,
} from '../../../test/utils/mock-factories';

import { SupportClinicResolver } from './support-clinic.resolver';
import { SupportActivityService } from './support-activity.service';
import { QuerySupportDiagnosticsDto } from './dto/query-support-diagnostics.dto';
import { SUPPORT_VISIBLE_AUDIT_ACTIONS } from './platform-support.constants';

const TENANT_ID = '55555555-5555-4555-8555-555555555555';
const query = (over: Partial<QuerySupportDiagnosticsDto> = {}) =>
  Object.assign(new QuerySupportDiagnosticsDto(), over);

describe('SupportActivityService', () => {
  let service: SupportActivityService;
  let tenants: MockRepository;
  let dataSource: MockDataSource;

  /** An audit row whose JSONB payloads carry exactly what must never escape. */
  const auditRow = {
    id: 'a1',
    action: 'platform_admin.override.grant',
    entity_type: 'FreeAccessOverride',
    entity_id: 'ov-1',
    created_at: new Date('2026-08-01T09:00:00Z'),
    old_values: { plan_id: 'plan-basic', api_key: 'sk_live_supersecret' },
    new_values: {
      plan_id: 'plan-pro',
      api_key: 'sk_live_rotated',
      ends_at: '2026-12-31',
      patient_note: 'diabetic, on metformin',
    },
    actor_name: 'Sara Al Otaibi',
    actor_email: 'sara@clinic.example',
    actor_is_platform: false,
  };

  beforeEach(async () => {
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    dataSource = createMockDataSource();
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql) ? [{ total: 1 }] : [auditRow],
    );

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SupportActivityService,
        SupportClinicResolver,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(SupportActivityService);
  });

  it('never returns raw old_values / new_values — only the NAMES of the fields that changed', async () => {
    const { data } = await service.timeline(TENANT_ID, query());

    expect(data[0]).not.toHaveProperty('oldValues');
    expect(data[0]).not.toHaveProperty('newValues');
    expect(data[0].changedFields).toEqual(['api_key', 'ends_at', 'patient_note', 'plan_id']);

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('sk_live_supersecret');
    expect(serialized).not.toContain('sk_live_rotated');
    expect(serialized).not.toContain('diabetic');
    expect(serialized).not.toContain('metformin');
    expect(serialized).not.toContain('plan-pro');
  });

  it('restricts the query to an allow-list of actions rather than filtering a denylist', async () => {
    await service.timeline(TENANT_ID, query());

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('al.action = ANY($3)');
    expect(params[2]).toEqual([...SUPPORT_VISIBLE_AUDIT_ACTIONS]);
    // Anything platform-financial or RBAC-related is absent from the list.
    expect(params[2]).not.toContain('platform_admin.payment_gateway.update');
    expect(params[2]).not.toContain('platform_admin.plan.create');
  });

  it('masks a clinic actor — Support is diagnosing a system, not auditing the clinic staff', async () => {
    const { data } = await service.timeline(TENANT_ID, query());

    expect(data[0].actor).toEqual({
      name: 'S*** A*** O***',
      email: 's***@clinic.example',
      isPlatformActor: false,
    });
  });

  it('shows a PLATFORM actor in full — accountability for our own staff runs the other way', async () => {
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql)
        ? [{ total: 1 }]
        : [
            {
              ...auditRow,
              actor_name: 'Mohamed Halem',
              actor_email: 'support@ziyaratech.com',
              actor_is_platform: true,
            },
          ],
    );

    const { data } = await service.timeline(TENANT_ID, query());

    expect(data[0].actor).toEqual({
      name: 'Mohamed Halem',
      email: 'support@ziyaratech.com',
      isPlatformActor: true,
    });
  });

  it('handles a system-initiated event with no actor at all', async () => {
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql)
        ? [{ total: 1 }]
        : [{ ...auditRow, actor_name: null, actor_email: null, actor_is_platform: null }],
    );

    const { data } = await service.timeline(TENANT_ID, query());

    expect(data[0].actor).toEqual({ name: null, email: null, isPlatformActor: false });
  });

  it('bounds the timeline by clinic, date window and page size', async () => {
    await service.timeline(TENANT_ID, query({ days: 7, page: 2, limit: 25 }));

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('al."tenantId" = $1');
    expect(sql).toContain('al.created_at >= $2');
    expect(params[0]).toBe(TENANT_ID);

    const [listSql, listParams] = dataSource.query.mock.calls[1];
    expect(listSql).toContain('LIMIT $4 OFFSET $5');
    expect(listParams[3]).toBe(25);
    expect(listParams[4]).toBe(25);
  });

  it('returns the pagination envelope with the window actually applied', async () => {
    const result = await service.timeline(TENANT_ID, query({ days: 90 }));

    expect(result).toMatchObject({ total: 1, page: 1, windowDays: 90 });
  });

  it('404s an unknown clinic before querying', async () => {
    tenants.exists.mockResolvedValue(false);

    await expect(service.timeline(TENANT_ID, query())).rejects.toMatchObject({
      code: ErrorCode.TENANT_NOT_FOUND,
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
