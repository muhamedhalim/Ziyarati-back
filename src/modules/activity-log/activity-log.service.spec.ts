import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import {
  createMockDataSource,
  MockDataSource,
} from '../../../test/utils/mock-factories';

import { ActivityLogService } from './activity-log.service';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';
import { ACTIVITY_VISIBLE_AUDIT_ACTIONS } from './activity-allowlist';

const TENANT_ID = '66666666-6666-4666-8666-666666666666';
const query = (over: Partial<QueryActivityLogDto> = {}) =>
  Object.assign(new QueryActivityLogDto(), over);

/**
 * T189 (spec 014, US14, FR-U007/FR-U008) — the allow-list and redaction spec.
 * This suite IS the exposure control's proof: an action absent from
 * `ACTIVITY_VISIBLE_AUDIT_ACTIONS` must never appear, no matter how it
 * arrives (including a hypothetical bug where the SQL filter itself is
 * bypassed and an unlisted row still comes back from the database), and no
 * rendered field — for ANY allow-listed action — may ever carry a raw value.
 *
 * Red before T191 (`ActivityLogService` does not exist yet).
 */
describe('ActivityLogService (T189, FR-U007/FR-U008)', () => {
  let service: ActivityLogService;
  let dataSource: MockDataSource;

  /** An audit row whose JSONB payloads carry exactly what must never escape. */
  const auditRow = {
    id: 'row-1',
    action: 'campaign.launched',
    entity_type: 'Campaign',
    entity_id: 'campaign-1',
    created_at: new Date('2026-08-01T09:00:00Z'),
    old_values: { status: 'DRAFT', api_key: 'sk_live_super_secret' },
    new_values: {
      status: 'RUNNING',
      api_key: 'sk_live_rotated',
      patient_note: 'diabetic, on metformin',
      card_number: '4242424242424242',
    },
    actor_id: 'user-1',
    actor_name: 'Sara Al Otaibi',
    actor_email: 'sara@clinic.example',
    actor_is_platform: false,
  };

  beforeEach(async () => {
    dataSource = createMockDataSource();
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql) ? [{ total: 1 }] : [auditRow],
    );

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityLogService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = moduleRef.get(ActivityLogService);
  });

  it('never returns raw old_values / new_values — only the NAMES of the fields that changed', async () => {
    const { data } = await service.list(TENANT_ID, query());

    expect(data[0]).not.toHaveProperty('oldValues');
    expect(data[0]).not.toHaveProperty('newValues');
    expect(data[0].changedFields).toEqual([
      'api_key',
      'card_number',
      'patient_note',
      'status',
    ]);

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('sk_live_super_secret');
    expect(serialized).not.toContain('sk_live_rotated');
    expect(serialized).not.toContain('diabetic');
    expect(serialized).not.toContain('metformin');
    expect(serialized).not.toContain('4242424242424242');
    expect(serialized).not.toContain('DRAFT');
    expect(serialized).not.toContain('RUNNING');
  });

  it('restricts the query to an allow-list of actions rather than filtering a denylist', async () => {
    await service.list(TENANT_ID, query());

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('al.action = ANY(');
    expect(params).toContainEqual([...ACTIVITY_VISIBLE_AUDIT_ACTIONS]);
  });

  it('an action added in code without being added to the allow-list never appears — invisibility by default, not by exception', async () => {
    // Simulates the SQL-level allow-list filter somehow being bypassed (a
    // stale cache row, a future refactor that forgets the WHERE clause) —
    // the service's OWN in-memory filter is the second, independent layer
    // that must still hide it.
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql)
        ? [{ total: 1 }]
        : [
            { ...auditRow, id: 'listed', action: 'campaign.launched' },
            {
              ...auditRow,
              id: 'unlisted',
              action: 'some.brand_new.action_nobody_reviewed',
            },
          ],
    );

    const { data } = await service.list(TENANT_ID, query());

    expect(data.map((d) => d.id)).toEqual(['listed']);
    expect(
      data.some((d) => d.action === 'some.brand_new.action_nobody_reviewed'),
    ).toBe(false);
  });

  it.each(ACTIVITY_VISIBLE_AUDIT_ACTIONS)(
    'action "%s" — changedFields is names only, never a raw value, and no secret/clinical content leaks',
    async (action) => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)/.test(sql)
          ? [{ total: 1 }]
          : [
              {
                ...auditRow,
                action,
                old_values: { plan_id: 'basic', token: 'secret-token-value' },
                new_values: {
                  plan_id: 'pro',
                  token: 'secret-token-value',
                  diagnosis: 'clinical-detail-value',
                },
              },
            ],
      );

      const { data } = await service.list(TENANT_ID, query());

      expect(data).toHaveLength(1);
      expect(data[0].action).toBe(action);
      expect(data[0].changedFields).toEqual(['diagnosis', 'plan_id', 'token']);
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain('secret-token-value');
      expect(serialized).not.toContain('clinical-detail-value');
      expect(serialized).not.toContain('basic');
      expect(serialized).not.toContain('"pro"');
    },
  );

  it('shows clinic staff BY NAME — unlike Support, which masks — an owner must see their own staff', async () => {
    const { data } = await service.list(TENANT_ID, query());

    expect(data[0].actor).toEqual({
      id: 'user-1',
      name: 'Sara Al Otaibi',
      email: 'sara@clinic.example',
    });
  });

  it('labels a platform-operator action with isPlatformActor: true', async () => {
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql)
        ? [{ total: 1 }]
        : [
            {
              ...auditRow,
              actor_id: 'platform-user-1',
              actor_name: 'Mohamed Halem',
              actor_email: 'support@ziyaratech.com',
              actor_is_platform: true,
            },
          ],
    );

    const { data } = await service.list(TENANT_ID, query());

    expect(data[0].isPlatformActor).toBe(true);
    expect(data[0].isSystem).toBe(false);
    expect(data[0].actor).toEqual({
      id: 'platform-user-1',
      name: 'Mohamed Halem',
      email: 'support@ziyaratech.com',
    });
  });

  it('a clinic-staff action has isPlatformActor: false', async () => {
    const { data } = await service.list(TENANT_ID, query());
    expect(data[0].isPlatformActor).toBe(false);
  });

  it('handles a system-initiated event with no actor at all — actor: null, isSystem: true', async () => {
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql)
        ? [{ total: 1 }]
        : [
            {
              ...auditRow,
              actor_id: null,
              actor_name: null,
              actor_email: null,
              actor_is_platform: null,
            },
          ],
    );

    const { data } = await service.list(TENANT_ID, query());

    expect(data[0].actor).toBeNull();
    expect(data[0].isSystem).toBe(true);
    expect(data[0].isPlatformActor).toBe(false);
  });

  it('an entry referencing a deleted entity still renders without erroring', async () => {
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql)
        ? [{ total: 1 }]
        : [{ ...auditRow, entity_id: 'a-since-deleted-id' }],
    );

    const { data } = await service.list(TENANT_ID, query());
    expect(data[0].entityId).toBe('a-since-deleted-id');
  });

  it('scopes the query to the tenant and applies pagination', async () => {
    await service.list(TENANT_ID, query({ page: 2, limit: 25 }));

    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('al."tenantId" = $1');
    expect(params[0]).toBe(TENANT_ID);

    const [listSql, listParams] = dataSource.query.mock.calls[1];
    expect(listSql).toContain('LIMIT');
    expect(listParams).toContain(25);
  });

  it('applies actor/action/date-range/free-text filters', async () => {
    await service.list(
      TENANT_ID,
      query({
        actorUserId: 'user-1',
        action: 'campaign.launched',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-12-31T00:00:00.000Z',
        q: 'campaign',
      }),
    );

    const [sql] = dataSource.query.mock.calls[0];
    expect(sql).toContain('al."userId" =');
    expect(sql).toContain('al.action =');
    expect(sql).toContain('al.created_at >=');
    expect(sql).toContain('al.created_at <=');
    expect(sql).toContain('al.action ILIKE');
  });

  it('orders newest first', async () => {
    await service.list(TENANT_ID, query());
    const [listSql] = dataSource.query.mock.calls[1];
    expect(listSql).toContain('ORDER BY al.created_at DESC');
  });

  it('returns the pagination envelope', async () => {
    const result = await service.list(TENANT_ID, query());
    expect(result).toMatchObject({ total: 1, page: 1, limit: 20 });
  });

  it('actions() returns exactly the allow-list, for the filter dropdown', () => {
    expect(service.actions()).toEqual([...ACTIVITY_VISIBLE_AUDIT_ACTIONS]);
  });
});
