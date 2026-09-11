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
import { AppError, ErrorCode } from '../../common/errors';
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

function build(
  options: {
    aiAllowed?: boolean;
    branchIds?: string[];
    /** Ids `branches.exists(...)` should answer `true` for (this tenant's branches). */
    tenantBranchIds?: string[];
  } = {},
) {
  const recorded: RecordedQuery[] = [];
  const row = {
    appointments: '128',
    myPatients: '37',
    customers: '412',
    staff: '9',
    pendingHandovers: '2',
  };

  // `user` is the FK the branch narrowing joins `branch_users` on — staff
  // carry no branch column of their own.
  const staffRepo = makeRepo('StaffProfile', recorded, row, {
    tenant: 'tenantId',
    user: 'userId',
  });
  const cacheKeys: string[] = [];

  // Branch repository double — backs the tenant-ownership check on a
  // requested `?branchId=`. Defaults to "nothing exists" so a test must opt
  // in via `tenantBranchIds`, the same fail-closed posture the real query has.
  const branchRepo = {
    exists: jest.fn(
      async ({ where }: { where: { id: string; tenant: { id: string } } }) =>
        (options.tenantBranchIds ?? []).includes(where.id),
    ),
  };

  // Real ABAC predicate (not a stub): tenant-wide (`branchIds: null`) allows
  // anything, a restricted scope allows only its own ids — mirrors
  // `BranchScopeService.isAllowed`/`assertBranchAllowed` exactly, so these
  // tests exercise the real composition rule, not a hand-waved double.
  const assertBranchAllowed = (
    scope: { branchIds: string[] | null },
    branchId: string,
  ) => {
    if (scope.branchIds === null) return;
    if (scope.branchIds.includes(branchId)) return;
    throw new AppError(ErrorCode.PERMISSION_DENIED, {
      message: 'You can only access branches you are assigned to',
    });
  };

  // StaffScopeService double — the extracted own-StaffProfile resolver
  // (formerly `DashboardSummaryService.resolveCallerStaffId`). Defaults to
  // the same "staff-of-caller" answer the old `staffRepo.findOne` mock gave,
  // so every pre-existing assertion in this suite keeps testing exactly what
  // it did; tests that need "no staff profile" now override THIS double
  // instead of `staffRepo.findOne`.
  const staffScope = {
    resolveOwnStaffId: jest.fn().mockResolvedValue('staff-of-caller'),
  };

  const service = new DashboardSummaryService(
    makeRepo('Appointment', recorded, row, {
      tenant: 'tenantId',
      staff: 'staffId',
      branch: 'branchId',
      customer: 'customerId',
    }) as never,
    makeRepo('Customer', recorded, row) as never,
    staffRepo as never,
    makeRepo('HandoverRequest', recorded, row) as never,
    makeRepo('Tenant', recorded, row) as never,
    branchRepo as never,
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
    // BranchScopeService double. `branchIds: null` (the default) is a
    // tenant-wide caller, which is what every pre-existing assertion in this
    // suite models — so those assertions keep testing exactly what they did.
    {
      resolve: jest
        .fn()
        .mockResolvedValue({ branchIds: options.branchIds ?? null }),
      assertBranchAllowed,
    } as never,
    staffScope as never,
  );

  return { service, recorded, cacheKeys, staffRepo, staffScope, branchRepo };
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
    it('answers all five counts with a SINGLE executed query', async () => {
      const { service, recorded } = build();

      const result = await service.get(TENANT, principal(ALL_FOUR));

      expect(recorded).toHaveLength(1);
      expect(result).toMatchObject({
        appointments: 128,
        myPatients: 37,
        customers: 412,
        staff: 9,
        pendingHandovers: 2,
      });
    });

    it('composes five independent scalar sub-selects, never a join between the tables', async () => {
      const { service, recorded } = build();
      await service.get(TENANT, principal(ALL_FOUR));

      const [query] = recorded;
      expect(query.selects.map((s) => s.alias)).toEqual([
        'appointments',
        'myPatients',
        'customers',
        'staff',
        'pendingHandovers',
      ]);
      // Each select is a parenthesised sub-SELECT, so the outer statement
      // returns exactly one row and no table is joined to another.
      // `myPatients` is COUNT(DISTINCT ...) — a different aggregate from the
      // other four's COUNT(*), so it is checked separately.
      for (const select of query.selects) {
        if (select.alias === 'myPatients') {
          expect(select.sql).toMatch(/^\(SELECT COUNT\(DISTINCT/);
        } else {
          expect(select.sql).toMatch(/^\(SELECT COUNT\(\*\)/);
        }
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

      // `myPatients` rides the SAME own-staff scope as `appointments` above —
      // same bound `:ownStaffId`, same FK column.
      const myPatients = recorded[0].selects.find(
        (s) => s.alias === 'myPatients',
      );
      expect(myPatients?.sql).toContain('"customerId"');
      expect(myPatients?.sql).toContain('"staffId" = :ownStaffId');
      expect(result.myPatients).toBe(37);
    });

    it('reports 0, not every appointment (or patient), when a read_own caller has no staff profile', async () => {
      const { service, recorded, staffScope } = build();
      staffScope.resolveOwnStaffId.mockResolvedValue(null);

      const result = await service.get(
        TENANT,
        principal([PERMISSION.APPOINTMENTS_READ_OWN]),
      );

      expect(recorded).toHaveLength(0);
      // 0 (a real answer), not null ("you may not ask") — the same answer
      // AppointmentService.findAll gives such a caller today.
      expect(result.appointments).toBe(0);
      expect(result.myPatients).toBe(0);
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

/**
 * ============================================================================
 *  Branch scoping — the Branch Manager's dashboard
 * ============================================================================
 *
 * The defect this closes: a Branch Manager opened `/app/dashboard` and saw the
 * clinic's totals, identical to the Owner's. These assertions pin the fix at
 * the layer that matters — the SQL — rather than at the tiles that render it.
 *
 * They also pin the two counts that deliberately are NOT narrowed (customers,
 * handovers: neither table has a branch column), so a later reader finds a
 * stated decision instead of an apparent omission.
 */
describe('DashboardSummaryService — branch scoping', () => {
  const BRANCH_A = 'branch-a';
  const BRANCH_B = 'branch-b';

  const appointmentsSql = (
    recorded: { selects: { sql: string; alias: string }[] }[],
  ) => recorded[0].selects.find((s) => s.alias === 'appointments')!.sql;
  const staffSql = (
    recorded: { selects: { sql: string; alias: string }[] }[],
  ) => recorded[0].selects.find((s) => s.alias === 'staff')!.sql;

  it('a tenant-wide caller composes the SAME SQL as before — no branch predicate at all', async () => {
    const { service, recorded } = build();
    await service.get(TENANT, principal(ALL_FOUR));

    for (const select of recorded[0].selects) {
      expect(select.sql).not.toContain('scopeBranchIds');
    }
    expect(recorded[0].params).not.toHaveProperty('scopeBranchIds');
  });

  it('narrows the appointment count to the caller’s branches', async () => {
    const { service, recorded } = build({ branchIds: [BRANCH_A] });
    await service.get(TENANT, principal(ALL_FOUR));

    expect(appointmentsSql(recorded)).toContain(
      'a."branchId" = ANY(:scopeBranchIds)',
    );
    expect(recorded[0].params.scopeBranchIds).toEqual([BRANCH_A]);
  });

  it('narrows the staff count through branch_users, with EXISTS so a two-branch member is not double counted', async () => {
    const { service, recorded } = build({ branchIds: [BRANCH_A, BRANCH_B] });
    await service.get(TENANT, principal(ALL_FOUR));

    const sql = staffSql(recorded);
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('branch_users');
    expect(sql).toContain('bu."branchId" = ANY(:scopeBranchIds)');
    expect(sql).toContain('bu."userId" = s."userId"');
    expect(sql).not.toContain('JOIN branch_users');
  });

  it('leaves customers and pending handovers tenant-wide — neither table has a branch column', async () => {
    const { service, recorded } = build({ branchIds: [BRANCH_A] });
    await service.get(TENANT, principal(ALL_FOUR));

    const customers = recorded[0].selects.find((s) => s.alias === 'customers')!;
    const handovers = recorded[0].selects.find(
      (s) => s.alias === 'pendingHandovers',
    )!;
    expect(customers.sql).not.toContain('scopeBranchIds');
    expect(handovers.sql).not.toContain('scopeBranchIds');
  });

  it('echoes the applied branch scope on the response, so the UI can name it', async () => {
    const { service } = build({ branchIds: [BRANCH_A] });
    const result = await service.get(TENANT, principal(ALL_FOUR));
    expect(result.scope.branchIds).toEqual([BRANCH_A]);
  });

  it('reports a null branch scope for a tenant-wide caller', async () => {
    const { service } = build();
    const result = await service.get(TENANT, principal(ALL_FOUR));
    expect(result.scope.branchIds).toBeNull();
  });

  it('still narrows when the caller is assigned to NO branch — an empty ANY() matches nothing', async () => {
    const { service, recorded } = build({ branchIds: [] });
    const result = await service.get(TENANT, principal(ALL_FOUR));

    expect(appointmentsSql(recorded)).toContain(
      'a."branchId" = ANY(:scopeBranchIds)',
    );
    expect(recorded[0].params.scopeBranchIds).toEqual([]);
    expect(result.scope.branchIds).toEqual([]);
  });

  describe('cache isolation', () => {
    it('never serves the tenant-wide entry to a branch-restricted caller', async () => {
      const wide = build();
      await wide.service.get(TENANT, principal(ALL_FOUR));

      const scoped = build({ branchIds: [BRANCH_A] });
      await scoped.service.get(TENANT, principal(ALL_FOUR));

      expect(wide.cacheKeys[0]).not.toEqual(scoped.cacheKeys[0]);
      expect(wide.cacheKeys[0]).toContain('b:all');
    });

    it('gives two managers of DIFFERENT branches different cache keys', async () => {
      const a = build({ branchIds: [BRANCH_A] });
      await a.service.get(TENANT, principal(ALL_FOUR));

      const b = build({ branchIds: [BRANCH_B] });
      await b.service.get(TENANT, principal(ALL_FOUR));

      expect(a.cacheKeys[0]).not.toEqual(b.cacheKeys[0]);
    });

    it('lets two managers of the SAME branch share one entry', async () => {
      const a = build({ branchIds: [BRANCH_A] });
      await a.service.get(TENANT, principal(ALL_FOUR));

      const b = build({ branchIds: [BRANCH_A] });
      await b.service.get(TENANT, principal(ALL_FOUR));

      expect(a.cacheKeys[0]).toEqual(b.cacheKeys[0]);
    });
  });
});

/**
 * ============================================================================
 *  The `?branchId=` request filter — the dashboard's branch DROPDOWN
 * ============================================================================
 *
 * Distinct from the suite above: that one proves the branch scope the SERVER
 * resolves from `branch_users`; this one proves what happens when the CLIENT
 * additionally asks to narrow to one branch — the never-trust-the-client
 * boundary (tenant ownership, then the caller's own ABAC scope) and its
 * effect on the cache key.
 */
describe('DashboardSummaryService — requested branchId filter', () => {
  const BRANCH_A = 'branch-a';
  const BRANCH_B = 'branch-b';
  const FOREIGN = 'foreign-tenant-branch';

  it('"All branches" (no filter) is byte-identical to today — same scope, same cache key', async () => {
    const withoutFilter = build({ tenantBranchIds: [BRANCH_A] });
    const withFilterOmitted = build({ tenantBranchIds: [BRANCH_A] });

    const a = await withoutFilter.service.get(TENANT, principal(ALL_FOUR));
    const b = await withFilterOmitted.service.get(
      TENANT,
      principal(ALL_FOUR),
      undefined,
    );

    expect(a.scope.branchIds).toBeNull();
    expect(b.scope.branchIds).toBeNull();
    expect(withoutFilter.cacheKeys[0]).toEqual(withFilterOmitted.cacheKeys[0]);
    expect(withoutFilter.branchRepo.exists).not.toHaveBeenCalled();
  });

  it('a tenant-wide caller (owner) narrows every count to the requested branch', async () => {
    const { service, recorded } = build({ tenantBranchIds: [BRANCH_A] });

    const result = await service.get(TENANT, principal(ALL_FOUR), BRANCH_A);

    expect(result.scope.branchIds).toEqual([BRANCH_A]);
    const appointments = recorded[0].selects.find(
      (s) => s.alias === 'appointments',
    )!;
    expect(appointments.sql).toContain('a."branchId" = ANY(:scopeBranchIds)');
    expect(recorded[0].params.scopeBranchIds).toEqual([BRANCH_A]);
  });

  it('rejects a branch id that does not belong to this tenant with NOT_FOUND (404), never a silent empty result', async () => {
    const { service, recorded } = build({ tenantBranchIds: [BRANCH_A] });

    await expect(
      service.get(TENANT, principal(ALL_FOUR), FOREIGN),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The rejection happens before the aggregation query — no partial/derived
    // numbers are ever computed for a branch outside the tenant.
    expect(recorded).toHaveLength(0);
  });

  it('rejects, with PERMISSION_DENIED (403), a branch that IS in the tenant but outside a branch-restricted caller’s own scope', async () => {
    const { service, recorded } = build({
      branchIds: [BRANCH_A],
      tenantBranchIds: [BRANCH_A, BRANCH_B],
    });

    await expect(
      service.get(TENANT, principal(ALL_FOUR), BRANCH_B),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(recorded).toHaveLength(0);
  });

  it('accepts a branch-restricted caller filtering to their OWN branch (a no-op narrowing)', async () => {
    const { service } = build({
      branchIds: [BRANCH_A],
      tenantBranchIds: [BRANCH_A, BRANCH_B],
    });

    const result = await service.get(TENANT, principal(ALL_FOUR), BRANCH_A);
    expect(result.scope.branchIds).toEqual([BRANCH_A]);
  });

  it('composes with `appointments.read_own`: a Doctor stays confined to their OWN appointments AND the selected branch — never every doctor at that branch', async () => {
    const { service, recorded } = build({ tenantBranchIds: [BRANCH_A] });

    const result = await service.get(
      TENANT,
      principal([PERMISSION.APPOINTMENTS_READ_OWN]),
      BRANCH_A,
    );

    const appointments = recorded[0].selects.find(
      (s) => s.alias === 'appointments',
    )!;
    // Both predicates present, ANDed — the branch filter narrows further, it
    // never replaces the caller's own-staff narrowing.
    expect(appointments.sql).toContain('"staffId" = :ownStaffId');
    expect(appointments.sql).toContain('a."branchId" = ANY(:scopeBranchIds)');
    expect(recorded[0].params.ownStaffId).toBe('staff-of-caller');
    expect(recorded[0].params.scopeBranchIds).toEqual([BRANCH_A]);
    expect(result.scope.appointments).toBe('OWN');
    expect(result.scope.branchIds).toEqual([BRANCH_A]);
  });

  describe('cache isolation', () => {
    it('gives the SAME caller different cache keys for different selected branches', async () => {
      const a = build({ tenantBranchIds: [BRANCH_A, BRANCH_B] });
      await a.service.get(TENANT, principal(ALL_FOUR), BRANCH_A);

      const b = build({ tenantBranchIds: [BRANCH_A, BRANCH_B] });
      await b.service.get(TENANT, principal(ALL_FOUR), BRANCH_B);

      expect(a.cacheKeys[0]).not.toEqual(b.cacheKeys[0]);
    });

    it('gives a selected-branch request a DIFFERENT key than the unfiltered ("all branches") request', async () => {
      const filtered = build({ tenantBranchIds: [BRANCH_A] });
      await filtered.service.get(TENANT, principal(ALL_FOUR), BRANCH_A);

      const unfiltered = build({ tenantBranchIds: [BRANCH_A] });
      await unfiltered.service.get(TENANT, principal(ALL_FOUR));

      expect(filtered.cacheKeys[0]).not.toEqual(unfiltered.cacheKeys[0]);
    });
  });
});
