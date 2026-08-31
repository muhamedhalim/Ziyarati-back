import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import {
  createMockDataSource,
  MockDataSource,
} from '../../../test/utils/mock-factories';

import { ActivityLogService } from './activity-log.service';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';
import { ACTIVITY_VISIBLE_AUDIT_ACTIONS } from './activity-allowlist';
import { QueryActivitySuggestionsDto } from './dto/query-activity-suggestions.dto';
import {
  ACTIVITY_SUGGESTION_LIMIT,
  ACTIVITY_SUGGESTION_SCAN_LIMIT,
} from './activity-log.constants';

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
    entity_label: 'Summer checkup',
    actor_user_id: 'user-1',
    actor_id: 'user-1',
    actor_name: 'Sara Al Otaibi',
    actor_email: 'sara@clinic.example',
    actor_is_platform: false,
    actor_role_slug: 'receptionist',
    actor_role_name: 'Receptionist',
    branch_id: 'branch-1',
    branch_name: 'Main Branch',
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
      role: { slug: 'receptionist', name: 'Receptionist' },
      isDeleted: false,
    });
  });

  it('labels a platform-operator action with isPlatformActor: true', async () => {
    dataSource.query = jest.fn(async (sql: string) =>
      /COUNT\(\*\)/.test(sql)
        ? [{ total: 1 }]
        : [
            {
              ...auditRow,
              actor_user_id: 'platform-user-1',
              actor_id: 'platform-user-1',
              actor_name: 'Mohamed Halem',
              actor_email: 'support@ziyaratech.com',
              actor_is_platform: true,
              actor_role_slug: null,
              actor_role_name: null,
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
      role: null,
      isDeleted: false,
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
              actor_user_id: null,
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
    expect(sql).toContain('u.full_name ILIKE');
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
  // ───────────────────── Actor identity & context ─────────────────────── //

  describe('actor identity', () => {
    it('a HARD-DELETED actor is reported as deleted, NOT silently re-attributed to the system', async () => {
      // The audit row still names a user; the join finds no row for them.
      // Conflating this with a system action would erase the fact that a
      // person did it — the exact opposite of what an audit log is for.
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)/.test(sql)
          ? [{ total: 1 }]
          : [
              {
                ...auditRow,
                actor_user_id: 'gone-user',
                actor_id: null,
                actor_name: null,
                actor_email: null,
                actor_is_platform: null,
                actor_role_slug: null,
                actor_role_name: null,
              },
            ],
      );

      const { data } = await service.list(TENANT_ID, query());

      expect(data[0].isSystem).toBe(false);
      expect(data[0].actor).toEqual({
        id: 'gone-user',
        name: null,
        email: null,
        role: null,
        isDeleted: true,
      });
    });

    it('resolves the actor role through a LATERAL single-row join, so a multi-role user cannot duplicate their own audit rows', async () => {
      await service.list(TENANT_ID, query());
      const [listSql] = dataSource.query.mock.calls[1];
      expect(listSql).toContain('LEFT JOIN LATERAL');
      expect(listSql).toContain('LIMIT 1');
    });

    it('carries the branch the action happened at', async () => {
      const { data } = await service.list(TENANT_ID, query());
      expect(data[0].branch).toEqual({ id: 'branch-1', name: 'Main Branch' });
    });

    it('a branchless action reports branch: null rather than a fabricated one', async () => {
      dataSource.query = jest.fn(async (sql: string) =>
        /COUNT\(\*\)/.test(sql)
          ? [{ total: 1 }]
          : [{ ...auditRow, branch_id: null, branch_name: null }],
      );
      const { data } = await service.list(TENANT_ID, query());
      expect(data[0].branch).toBeNull();
    });

    it('carries the non-sensitive entity label', async () => {
      const { data } = await service.list(TENANT_ID, query());
      expect(data[0].entityLabel).toBe('Summer checkup');
    });
  });

  // ──────────────────────────── Search ─────────────────────────────────── //

  describe('search (q)', () => {
    const listSqlFor = async (over: Partial<QueryActivityLogDto>) => {
      dataSource.query.mockClear();
      await service.list(TENANT_ID, query(over));
      return {
        countSql: dataSource.query.mock.calls[0][0] as string,
        sql: dataSource.query.mock.calls[1][0] as string,
        params: dataSource.query.mock.calls[1][1] as unknown[],
      };
    };

    it('matches across action, entity type, entity label, actor name, actor email and branch', async () => {
      const { sql } = await listSqlFor({ q: 'ahmed' });
      for (const column of [
        'al.action ILIKE',
        'al.entity_type ILIKE',
        'al.entity_label ILIKE',
        'u.full_name ILIKE',
        'u.email ILIKE',
        'b.name ILIKE',
      ]) {
        expect(sql).toContain(column);
      }
    });

    it('is a CONTAINS match, so a partial word finds the whole one', async () => {
      const { params } = await listSqlFor({ q: 'appoint' });
      expect(params).toContain('%appoint%');
    });

    it('is case-insensitive via ILIKE, never a lower() wrapper that would defeat the index', async () => {
      const { sql, params } = await listSqlFor({ q: 'AHMED' });
      expect(sql).toContain('ILIKE');
      expect(sql).not.toContain('lower(al.action)');
      // The term reaches SQL exactly as typed — ILIKE does the folding.
      expect(params).toContain('%AHMED%');
    });

    it('passes Arabic terms through untouched', async () => {
      const { params } = await listSqlFor({ q: 'أحمد' });
      expect(params).toContain('%أحمد%');
    });

    it('escapes LIKE metacharacters so user input cannot alter the query semantics', async () => {
      const { params } = await listSqlFor({ q: '100%_x' });
      expect(params).toContain(String.raw`%100\%\_x%`);
    });

    it('escapes a backslash BEFORE it can escape anything else', async () => {
      const { params } = await listSqlFor({ q: String.raw`a\%b` });
      expect(params).toContain(String.raw`%a\\\%b%`);
    });

    it('ignores a whitespace-only search rather than running one', async () => {
      const { sql } = await listSqlFor({ q: '   ' });
      expect(sql).not.toContain('ILIKE');
    });

    it('ignores a single character — below the width a trigram index can be selective on', async () => {
      const { sql } = await listSqlFor({ q: 'a' });
      expect(sql).not.toContain('ILIKE');
    });

    it('runs a two-character search', async () => {
      const { params } = await listSqlFor({ q: 'Ah' });
      expect(params).toContain('%Ah%');
    });

    it('trims before searching, so a trailing space does not change the result set', async () => {
      const { params } = await listSqlFor({ q: '  Ahmed  ' });
      expect(params).toContain('%Ahmed%');
    });

    it('counts through the SAME joins and predicate as the page, so total never disagrees with it', async () => {
      const { countSql } = await listSqlFor({ q: 'ahmed' });
      expect(countSql).toContain('LEFT JOIN users u');
      expect(countSql).toContain('LEFT JOIN branches b');
      expect(countSql).toContain('u.full_name ILIKE');
    });

    it('composes with the action filter and with pagination', async () => {
      dataSource.query.mockClear();
      await service.list(
        TENANT_ID,
        query({
          q: 'appoint',
          action: 'appointment.created',
          page: 3,
          limit: 10,
        }),
      );
      const [sql, params] = dataSource.query.mock.calls[1];
      expect(sql).toContain('al.action = $');
      expect(sql).toContain('ILIKE');
      // Page 3 at 10/page → OFFSET 20, still tenant- and allow-list-bound.
      expect(params).toContain(20);
      expect(params[0]).toBe(TENANT_ID);
    });

    it('never drops the tenant or allow-list binding when searching', async () => {
      const { sql, params } = await listSqlFor({ q: 'ahmed' });
      expect(sql).toContain('al."tenantId" = $1');
      expect(sql).toContain('al.action = ANY($2)');
      expect(params[0]).toBe(TENANT_ID);
    });
  });

  describe('branch and date filters', () => {
    it('filters on the indexed branch column', async () => {
      dataSource.query.mockClear();
      await service.list(TENANT_ID, query({ branchId: 'branch-1' }));
      const [sql] = dataSource.query.mock.calls[0];
      expect(sql).toContain('al."branchId" =');
    });

    it('compares created_at directly, never wrapped in a function, so the index stays usable', async () => {
      dataSource.query.mockClear();
      await service.list(
        TENANT_ID,
        query({ from: '2026-01-01T00:00:00.000Z' }),
      );
      const [sql] = dataSource.query.mock.calls[0];
      expect(sql).toContain('al.created_at >=');
      expect(sql).not.toMatch(/date\(al\.created_at\)|al\.created_at::date/);
    });
  });

  // ───────────────────────── Suggestions ───────────────────────────────── //

  describe('suggestions', () => {
    const suggestionQuery = (over: Partial<QueryActivitySuggestionsDto> = {}) =>
      Object.assign(new QueryActivitySuggestionsDto(), over);

    beforeEach(() => {
      dataSource.query = jest.fn(async (sql: string) => {
        if (/pg_extension/.test(sql)) return [{ ok: 1 }]; // pg_trgm present
        return [
          { value: 'Ahmed Mohamed', kind: 'actor', rank: 1 },
          { value: 'Mohamed Ahmed', kind: 'actor', rank: 2 },
        ];
      });
    });

    it('returns bounded, ranked suggestions', async () => {
      const { data } = await service.suggestions(
        TENANT_ID,
        suggestionQuery({ q: 'Ahmed' }),
      );
      expect(data).toEqual([
        { value: 'Ahmed Mohamed', kind: 'actor' },
        { value: 'Mohamed Ahmed', kind: 'actor' },
      ]);
    });

    it('ranks exact, then prefix, then trigram similarity, then alphabetical', async () => {
      await service.suggestions(TENANT_ID, suggestionQuery({ q: 'Ahmed' }));
      const sql = dataSource.query.mock.calls.at(-1)![0] as string;
      expect(sql).toContain('ORDER BY rank ASC, score DESC, value ASC');
      expect(sql).toContain('similarity(value, $4::text)');
    });

    it('falls back to a constant score — never an error — when pg_trgm is absent', async () => {
      dataSource.query = jest.fn(async () => []);
      await service.suggestions(TENANT_ID, suggestionQuery({ q: 'Ahmed' }));
      const sql = dataSource.query.mock.calls.at(-1)![0] as string;
      expect(sql).toContain('0::real');
      expect(sql).not.toContain('similarity(');
    });

    it('binds every branch to the caller tenant AND the allow-list — a suggestion can never cross a tenant', async () => {
      await service.suggestions(TENANT_ID, suggestionQuery({ q: 'Ahmed' }));
      const [sql, params] = dataSource.query.mock.calls.at(-1)!;
      const tenantBindings = (sql.match(/al\."tenantId" = \$1/g) ?? []).length;
      const allowListBindings = (sql.match(/al\.action = ANY\(\$2\)/g) ?? [])
        .length;
      expect(tenantBindings).toBe(4); // one per UNION branch
      expect(allowListBindings).toBe(4);
      expect(params[0]).toBe(TENANT_ID);
      expect(params[1]).toEqual([...ACTIVITY_VISIBLE_AUDIT_ACTIONS]);
    });

    it('caps the result count and bounds the rows each branch scans', async () => {
      await service.suggestions(
        TENANT_ID,
        suggestionQuery({ q: 'Ahmed', limit: 99 }),
      );
      const params = dataSource.query.mock.calls.at(-1)![1] as unknown[];
      expect(params).toContain(ACTIVITY_SUGGESTION_LIMIT); // clamped, not 99
      expect(params).toContain(ACTIVITY_SUGGESTION_SCAN_LIMIT);
    });

    it('returns an empty list — issuing no query at all — for a term below the minimum', async () => {
      dataSource.query.mockClear();
      const { data } = await service.suggestions(
        TENANT_ID,
        suggestionQuery({ q: 'a' }),
      );
      expect(data).toEqual([]);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('returns an empty list for a missing term', async () => {
      dataSource.query.mockClear();
      const { data } = await service.suggestions(TENANT_ID, suggestionQuery());
      expect(data).toEqual([]);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('uses the RAW term for the exact-match tier and the ESCAPED one for the patterns', async () => {
      await service.suggestions(TENANT_ID, suggestionQuery({ q: '50%' }));
      const params = dataSource.query.mock.calls.at(-1)![1] as unknown[];
      expect(params).toContain('50%'); // $4, raw — for lower(value) = lower($4)
      expect(params).toContain(String.raw`%50\%%`); // $3, escaped — for ILIKE
    });

    it('asks whether pg_trgm exists once, not once per keystroke', async () => {
      await service.suggestions(TENANT_ID, suggestionQuery({ q: 'Ahmed' }));
      await service.suggestions(TENANT_ID, suggestionQuery({ q: 'Ahme' }));
      await service.suggestions(TENANT_ID, suggestionQuery({ q: 'Ahm' }));
      const probes = dataSource.query.mock.calls.filter(([sql]: [string]) =>
        /pg_extension/.test(sql),
      );
      expect(probes).toHaveLength(1);
    });
  });
});
