/**
 * `DashboardSummaryService` — the replacement for the dashboard's four
 * `?limit=1` list calls.
 *
 * Three properties are load-bearing and each is asserted here:
 *
 *  1. **ONE statement.** The whole point of the endpoint is that four counts
 *     cost one round trip. A regression that reintroduced four queries would
 *     still return correct numbers and pass any output-only test, so the test
 *     counts the query builders that actually execute.
 *  2. **Per-metric authorization.** Aggregating four resources into one
 *     response must not aggregate their permissions. A count the caller may
 *     not read must be absent from the SQL entirely and come back `null` —
 *     never `0`, which would be indistinguishable from "you have none".
 *  3. **Scope-keyed caching.** A doctor scoped to their own appointments and
 *     a receptionist seeing the whole clinic must not share a cache entry.
 *
 * The repositories are recorded fakes rather than a live database: this
 * asserts the STATEMENT the service composes and the decisions it makes, both
 * of which are pure functions of the inputs. The SQL's behaviour against real
 * data (soft-delete exclusion, index usage) is TypeORM's own contract and is
 * covered by the integration suites that run against Postgres.
 */
import { DashboardSummaryService } from './dashboard-summary.service';
import { PERMISSION } from '../../rbac/rbac.constants';
import { HANDOVER_STATUS } from '../ai/ai.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

const TENANT = 'tenant-1';

interface RecordedQuery {
  selects: { sql: string; alias: string }[];
  wheres: string[];
  params: Record<string, unknown>;
}

/** Minimal QueryBuilder recorder — records what was composed, executes nothing. */
function makeQb(recorded: RecordedQuery[], row: Record<string, string>) {
  const q: RecordedQuery = { selects: [], wheres: [], params: {} };
  const qb: Record<string, unknown> = {
    select(sql: string, alias?: string) {
      q.selects = [{ sql, alias: alias ?? '' }];
      return qb;
    },
    addSelect(sql: string, alias?: string) {
      q.selects.push({ sql, alias: alias ?? '' });
      return qb;
    },
    where(sql: string, params?: Record<string, unknown>) {
      q.wheres = [sql];
      Object.assign(q.params, params ?? {});
      return qb;
    },
    andWhere(sql: string, params?: Record<string, unknown>) {
      q.wheres.push(sql);
      Object.assign(q.params, params ?? {});
      return qb;
    },
    setParameter(key: string, value: unknown) {
      q.params[key] = value;
      return qb;
    },
    getQuery() {
      return `SELECT ${q.selects.map((s) => s.sql).join(', ')} WHERE ${q.wheres.join(' AND ')}`;
    },
    getRawOne() {
      // Only a builder that is actually EXECUTED counts as a round trip.
      recorded.push(q);
      return Promise.resolve(row);
    },
  };
  return qb;
}

function makeRepo(
  entityName: string,
  recorded: RecordedQuery[],
  row: Record<string, string>,
  relations: Record<string, string> = { tenant: 'tenantId' },
) {
  return {
    metadata: {
      name: entityName,
      findRelationWithPropertyPath: (path: string) =>
        relations[path]
          ? { joinColumns: [{ databaseName: relations[path] }] }
          : undefined,
    },
    createQueryBuilder: () => makeQb(recorded, row),
    findOne: jest.fn().mockResolvedValue({ id: 'staff-of-caller' }),
  };
}

function build(options: { aiAllowed?: boolean } = {}) {
  const recorded: RecordedQuery[] = [];
  const row = {
    appointments: '128',
    customers: '412',
    staff: '9',
    pendingHandovers: '2',
  };

  const staffRepo = makeRepo('StaffProfile', recorded, row);
  const cacheKeys: string[] = [];

  const service = new DashboardSummaryService(
    makeRepo('Appointment', recorded, row, {
      tenant: 'tenantId',
      staff: 'staffId',
    }) as never,
    makeRepo('Customer', recorded, row) as never,
    staffRepo as never,
    makeRepo('HandoverRequest', recorded, row) as never,
    makeRepo('Tenant', recorded, row) as never,
    {
      // Pass-through: identical to the real service with no REDIS_URL.
      wrap: <T>(
        _t: string,
        _ns: string,
        suffix: string,
        producer: () => Promise<T>,
      ) => {
        cacheKeys.push(suffix);
        return producer();
      },
    } as never,
    {
      resolve: jest
        .fn()
        .mockResolvedValue({ allowed: options.aiAllowed ?? true }),
    } as never,
  );

  return { service, recorded, cacheKeys, staffRepo };
}

function principal(permissions: string[]): AuthenticatedUser {
  return {
    id: 'user-1',
    tenantId: TENANT,
    roles: [],
    permissions,
  } as AuthenticatedUser;
}

const ALL_FOUR = [
  PERMISSION.APPOINTMENTS_READ,
  PERMISSION.CRM_CUSTOMERS_READ,
  PERMISSION.STAFF_READ,
  PERMISSION.AI_HANDOVER_READ,
];

describe('DashboardSummaryService', () => {
  describe('one round trip', () => {
    it('answers all four counts with a SINGLE executed query', async () => {
      const { service, recorded } = build();

      const result = await service.get(TENANT, principal(ALL_FOUR));

      expect(recorded).toHaveLength(1);
      expect(result).toMatchObject({
        appointments: 128,
        customers: 412,
        staff: 9,
        pendingHandovers: 2,
      });
    });

    it('composes four independent scalar sub-selects, never a join between the tables', async () => {
      const { service, recorded } = build();
      await service.get(TENANT, principal(ALL_FOUR));

      const [query] = recorded;
      expect(query.selects.map((s) => s.alias)).toEqual([
        'appointments',
        'customers',
        'staff',
        'pendingHandovers',
      ]);
      // Each select is a parenthesised sub-SELECT, so the outer statement
      // returns exactly one row and no table is joined to another.
      for (const select of query.selects) {
        expect(select.sql).toMatch(/^\(SELECT COUNT\(\*\)/);
      }
      // The outer FROM is the tenant row itself — the anchor that makes a
      // no-FROM select list legal and guarantees a single result row.
      expect(query.wheres).toContain('t.id = :tenantId');
    });

    it('scopes every sub-select by the FK column read from entity metadata', async () => {
      const { service, recorded } = build();
      await service.get(TENANT, principal(ALL_FOUR));

      for (const select of recorded[0].selects) {
        expect(select.sql).toContain('"tenantId" = :tenantId');
      }
      expect(recorded[0].params.tenantId).toBe(TENANT);
    });

    it('counts only PENDING handovers', async () => {
      const { service, recorded } = build();
      await service.get(TENANT, principal(ALL_FOUR));

      const handovers = recorded[0].selects.find(
        (s) => s.alias === 'pendingHandovers',
      );
      expect(handovers?.sql).toContain('h.status = :pendingStatus');
      expect(recorded[0].params.pendingStatus).toBe(HANDOVER_STATUS.PENDING);
    });
  });

  describe('per-metric authorization', () => {
    it('returns null — not 0 — for a count the caller may not read', async () => {
      const { service } = build();

      const result = await service.get(
        TENANT,
        principal([PERMISSION.CRM_CUSTOMERS_READ]),
      );

      expect(result.customers).toBe(412);
      expect(result.appointments).toBeNull();
      expect(result.staff).toBeNull();
      expect(result.pendingHandovers).toBeNull();
    });

    it('omits an unauthorized count from the SQL entirely', async () => {
      const { service, recorded } = build();
      await service.get(TENANT, principal([PERMISSION.STAFF_READ]));

      expect(recorded[0].selects.map((s) => s.alias)).toEqual(['staff']);
    });

    it('issues no query at all when the caller may read none of the four', async () => {
      const { service, recorded } = build();

      const result = await service.get(TENANT, principal([]));

      expect(recorded).toHaveLength(0);
      expect(result).toMatchObject({
        appointments: null,
        customers: null,
        staff: null,
        pendingHandovers: null,
      });
    });

    it('narrows appointments to the caller’s own staff profile for `appointments.read_own`', async () => {
      const { service, recorded } = build();

      const result = await service.get(
        TENANT,
        principal([PERMISSION.APPOINTMENTS_READ_OWN]),
      );

      const appointments = recorded[0].selects.find(
        (s) => s.alias === 'appointments',
      );
      expect(appointments?.sql).toContain('"staffId" = :ownStaffId');
      expect(recorded[0].params.ownStaffId).toBe('staff-of-caller');
      expect(result.scope.appointments).toBe('OWN');
    });

    it('reports 0, not every appointment, when a read_own caller has no staff profile', async () => {
      const { service, recorded, staffRepo } = build();
      staffRepo.findOne.mockResolvedValue(null);

      const result = await service.get(
        TENANT,
        principal([PERMISSION.APPOINTMENTS_READ_OWN]),
      );

      expect(recorded).toHaveLength(0);
      // 0 (a real answer), not null ("you may not ask") — the same answer
      // AppointmentService.findAll gives such a caller today.
      expect(result.appointments).toBe(0);
      expect(result.scope.appointments).toBe('OWN');
    });

    it('withholds the handover count when the tenant lacks the AI capability, even with the permission', async () => {
      const { service, recorded } = build({ aiAllowed: false });

      const result = await service.get(TENANT, principal(ALL_FOUR));

      expect(result.pendingHandovers).toBeNull();
      expect(recorded[0].selects.map((s) => s.alias)).not.toContain(
        'pendingHandovers',
      );
    });
  });

  describe('cache keying', () => {
    it('gives callers with different visibility different cache keys', async () => {
      const wide = build();
      await wide.service.get(TENANT, principal(ALL_FOUR));

      const narrow = build();
      await narrow.service.get(
        TENANT,
        principal([PERMISSION.APPOINTMENTS_READ_OWN]),
      );

      expect(wide.cacheKeys[0]).not.toEqual(narrow.cacheKeys[0]);
      expect(narrow.cacheKeys[0]).toContain('own:staff-of-caller');
    });

    it('lets two callers with identical visibility share one cache key', async () => {
      const a = build();
      await a.service.get(TENANT, principal(ALL_FOUR));

      const b = build();
      await b.service.get(TENANT, principal([...ALL_FOUR].reverse()));

      expect(a.cacheKeys[0]).toEqual(b.cacheKeys[0]);
    });
  });
});
