import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository } from 'typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { AppError, ErrorCode } from '../../common/errors';
import { PERMISSION } from '../../rbac/rbac.constants';
import {
  AnalyticsCacheService,
  CACHE_NS,
} from '../analytics/analytics-cache.service';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { HANDOVER_STATUS } from '../ai/ai.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  BranchScopeService,
  type BranchScope,
} from '../../core/branch-scope/branch-scope.service';
import { StaffScopeService } from '../../core/staff-scope/staff-scope.service';

/**
 * The four headline counts the clinic/reception dashboard renders.
 *
 * `null` means "this caller may not read that count" — NOT zero. The tile
 * renders a muted dash for it, exactly as it did when the corresponding list
 * endpoint answered 403.
 */
export interface DashboardSummary {
  appointments: number | null;
  customers: number | null;
  /**
   * Distinct customers across the appointments this caller may read — NOT
   * the same question `customers` answers. For a caller scoped to
   * `appointments.read_own` (today: doctor) this is genuinely "how many of
   * MY patients", counted under the identical own-staff + branch scope as
   * `appointments`. For a tenant-wide caller it is still narrower than
   * `customers`: "patients with at least one appointment" vs. "every
   * customer record in the clinic". `null` under the same rule as every
   * other count here — the caller may not ask, not "the answer is zero".
   */
  myPatients: number | null;
  staff: number | null;
  pendingHandovers: number | null;
  /** Echoes what the caller was actually allowed to see — never client-guessed. */
  scope: {
    appointments: 'ALL' | 'OWN' | 'NONE';
    /**
     * The BRANCH narrowing actually applied to this payload — resolved
     * server-side, echoed back, never client-guessed.
     *
     * `null` for a tenant-wide caller with no `?branchId=` filter. For a
     * branch-restricted caller (e.g. a Branch Manager) it is their assigned
     * branches from `branch_users`. When the caller passed a validated
     * `?branchId=`, it is that ONE branch, regardless of role — the filter
     * only ever narrows further, never widens past the caller's own scope.
     */
    branchIds: string[] | null;
  };
  generatedAt: string;
}

/** Which counts a given principal is permitted to read. */
interface Grants {
  appointments: 'ALL' | 'OWN' | 'NONE';
  customers: boolean;
  staff: boolean;
  handovers: boolean;
}

/**
 * ONE round trip for the whole dashboard KPI row.
 *
 * ── WHY THIS ENDPOINT EXISTS ────────────────────────────────────────────────
 * The dashboard used to render these four numbers by calling four *list*
 * endpoints with `limit=1` and reading `total` off the pagination envelope.
 * That is four HTTP requests, four RBAC principal joins, and — because the
 * list services hydrate entities and their relations — roughly thirteen
 * database queries to produce four integers. `/staff?limit=1` alone cost six:
 * `findAndCount`, then `getAccessStates` (users + user_roles + password_resets)
 * and `withRoleDetail`, none of which a count needs.
 *
 * ── WHY ONE SQL STATEMENT AND NOT FOUR ──────────────────────────────────────
 * The four tables are unrelated: appointments, customers, staff_profiles and
 * handover_requests share only `tenantId`. JOINing them would produce a
 * Cartesian product (appointments × customers rows), which is both wrong and
 * catastrophically slow — the exact trap a naive "just use a JOIN" pass falls
 * into. What IS correct is four independent scalar sub-SELECTs in a single
 * statement, anchored on the tenant row:
 *
 *     SELECT (SELECT COUNT(*) FROM appointments  WHERE …) AS appointments,
 *            (SELECT COUNT(*) FROM customers     WHERE …) AS customers,
 *            …
 *       FROM tenants t WHERE t.id = $1
 *
 * Postgres plans each sub-SELECT as its own index scan — the same four scans
 * four separate queries would have produced — but the client pays ONE network
 * round trip instead of four, and the `FROM tenants` anchor guarantees exactly
 * one result row.
 *
 * The sub-selects are built from TypeORM query builders rather than hand-
 * written SQL, so table names, the `tenantId` FK column and the soft-delete
 * predicate (`deleted_at IS NULL`, which three of these four entities carry)
 * all come from entity metadata and cannot drift from the entities.
 *
 * ── AUTHORIZATION ───────────────────────────────────────────────────────────
 * Aggregating four resources into one response must not aggregate their
 * permissions. Each count is included ONLY if the caller holds the same
 * permission its list endpoint requires, resolved from the verified principal:
 *
 *   appointments      → `appointments.read` (tenant-wide) or
 *                       `appointments.read_own` (forced to the caller's own
 *                       StaffProfile, never a request-supplied staff id)
 *   customers         → `crm.customers.read`
 *   staff             → `staff.read`
 *   pendingHandovers  → `ai.handover.read` AND the tenant's `ai` capability,
 *                       because `/ai/handovers` also carries
 *                       `@RequireFeature(FeatureKey.AI_ASSISTANT)`; dropping that here
 *                       would let this endpoint answer a question the resource
 *                       endpoint refuses.
 *
 * A count the caller may not read is omitted from the SQL entirely — the row
 * is never counted, not counted-then-hidden.
 */
@Injectable()
export class DashboardSummaryService {
  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
    @InjectRepository(HandoverRequest)
    private readonly handovers: Repository<HandoverRequest>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    private readonly cache: AnalyticsCacheService,
    private readonly access: AccessControlService,
    private readonly branchScope: BranchScopeService,
    private readonly staffScope: StaffScopeService,
  ) {}

  async get(
    tenantId: string,
    user: AuthenticatedUser,
    requestedBranchId?: string,
  ): Promise<DashboardSummary> {
    const grants = await this.resolveGrants(tenantId, user);

    // `appointments.read_own` narrows the count to the caller's own staff
    // profile, so the cached value must be keyed by that caller — never shared
    // with the tenant-wide count. Everyone holding the tenant-wide permission
    // shares one entry.
    const ownStaffId =
      grants.appointments === 'OWN'
        ? await this.staffScope.resolveOwnStaffId(tenantId, user.id)
        : null;

    // The BRANCH narrowing, on top of (not instead of) the permission
    // narrowing above. Tenant-wide for every role that exists today except a
    // branch-restricted one, so this is a no-op for owner/manager/
    // receptionist/doctor and their cache entries are unchanged UNLESS a
    // `?branchId=` filter was also requested.
    const branchScope = await this.effectiveBranchScope(
      tenantId,
      await this.branchScope.resolve(tenantId, user),
      requestedBranchId,
    );

    const suffix = this.cacheSuffix(grants, ownStaffId, branchScope);

    const counts = await this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      suffix,
      () => this.countAll(tenantId, grants, ownStaffId, branchScope),
    );

    return {
      ...counts,
      scope: {
        appointments: grants.appointments,
        branchIds: branchScope.branchIds,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Intersects a client-requested `?branchId=` into the caller's own
   * server-resolved scope. The request-supplied id is NEVER trusted as-is:
   *
   *  1. It must belong to THIS tenant — 404 otherwise (mirrors
   *     `AppointmentService.assertBranch`); a cross-tenant id must never
   *     silently resolve to zero rows, which is what relying on the SQL's own
   *     `tenantId` predicate alone would do.
   *  2. It must be inside the caller's OWN branch scope — 403 otherwise, via
   *     the shared {@link BranchScopeService.assertBranchAllowed} (identical
   *     rule `ActivityLogController` applies to its own `?branchId=`).
   *
   * A caller who is tenant-wide (`branchScope.branchIds === null` — Owner,
   * Manager, Receptionist, or a Doctor, none of whom are branch-RESTRICTED)
   * may request any branch that exists in the tenant: step 2 always passes
   * for them, so step 1 is what actually guards the boundary. For a
   * branch-restricted caller (a Branch Manager) step 2 additionally confines
   * the request to branches they are assigned to.
   *
   * No filter requested → the resolved scope is returned untouched, so
   * "All branches" (the default) is byte-identical to today's behaviour.
   */
  private async effectiveBranchScope(
    tenantId: string,
    branchScope: BranchScope,
    requestedBranchId: string | undefined,
  ): Promise<BranchScope> {
    if (!requestedBranchId) return branchScope;

    const belongsToTenant = await this.branches.exists({
      where: { id: requestedBranchId, tenant: { id: tenantId } },
    });
    if (!belongsToTenant) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
    }
    this.branchScope.assertBranchAllowed(branchScope, requestedBranchId);

    return { branchIds: [requestedBranchId] };
  }

  // ── Authorization ────────────────────────────────────────────────────────

  private async resolveGrants(
    tenantId: string,
    user: AuthenticatedUser,
  ): Promise<Grants> {
    const has = (perm: string) => user.permissions.includes(perm);

    let handovers = has(PERMISSION.AI_HANDOVER_READ);
    if (handovers) {
      // `/ai/handovers` is additionally behind `@RequireFeature(FeatureKey.AI_ASSISTANT)`.
      // Resolved through the SAME authority the guard uses (and its 5-second
      // cache, already warm from this request's own guard chain), never a
      // second implementation of the rule.
      const decision = await this.access.resolve(
        tenantId,
        FeatureKey.AI_ASSISTANT,
      );
      handovers = decision.allowed;
    }

    return {
      appointments: has(PERMISSION.APPOINTMENTS_READ)
        ? 'ALL'
        : has(PERMISSION.APPOINTMENTS_READ_OWN)
          ? 'OWN'
          : 'NONE',
      customers: has(PERMISSION.CRM_CUSTOMERS_READ),
      staff: has(PERMISSION.STAFF_READ),
      handovers,
    };
  }

  /**
   * Cache key must encode the caller's VISIBILITY, or a receptionist's cached
   * response could be served to a doctor whose scope is narrower.
   *
   * The branch scope is part of that visibility and is therefore part of the
   * key: a Branch Manager must never be served the tenant-wide entry, and two
   * managers of different branches must never share one. `all` (the
   * tenant-wide marker) is a distinct value from any branch id list, and the
   * ids are already sorted by `BranchScopeService`, so the same scope always
   * produces the same key.
   *
   * `myPatients` needs NO key of its own: it is gated by the exact same
   * `grants.appointments`/`ownStaffId` pair the `a:` part below already
   * encodes, and computed from the identical bound parameters — there is no
   * third input for a key to miss.
   */
  private cacheSuffix(
    grants: Grants,
    ownStaffId: string | null,
    branchScope: BranchScope,
  ): string {
    const parts = [
      `a:${grants.appointments === 'OWN' ? `own:${ownStaffId ?? 'none'}` : grants.appointments}`,
      `c:${grants.customers ? 1 : 0}`,
      `s:${grants.staff ? 1 : 0}`,
      `h:${grants.handovers ? 1 : 0}`,
      `b:${branchScope.branchIds === null ? 'all' : branchScope.branchIds.join(',') || 'none'}`,
    ];
    return `summary:${parts.join('|')}`;
  }

  // ── The single statement ─────────────────────────────────────────────────

  /**
   * The database column backing a `@ManyToOne` relation, read from entity
   * metadata rather than assumed to be `"<property>Id"`.
   *
   * A count sub-select must filter on the FK column directly — joining to
   * `tenants` (this codebase's usual `.innerJoin('a.tenant','t')` idiom) would
   * add a needless join to a query whose entire job is one index count, and
   * these sub-selects are already anchored on the tenant row by the outer
   * `FROM tenants`. Reading the name from metadata is what keeps that
   * shortcut from silently breaking if a `@JoinColumn({ name })` is ever added.
   */
  private fk(repo: Repository<ObjectLiteral>, property: string): string {
    const relation = repo.metadata.findRelationWithPropertyPath(property);
    const column = relation?.joinColumns[0]?.databaseName;
    if (!column) {
      throw new Error(
        `${repo.metadata.name}.${property} has no join column — dashboard summary cannot scope by it`,
      );
    }
    return column;
  }

  private async countAll(
    tenantId: string,
    grants: Grants,
    ownStaffId: string | null,
    branchScope: BranchScope,
  ): Promise<Omit<DashboardSummary, 'scope' | 'generatedAt'>> {
    const qb = this.tenants
      .createQueryBuilder('t')
      .where('t.id = :tenantId', { tenantId });

    let selected = false;
    const add = (sql: string, alias: string) => {
      qb[selected ? 'addSelect' : 'select'](sql, alias);
      selected = true;
    };

    // The branch narrowing, bound ONCE for every sub-select that can use it.
    // A restricted caller assigned to no branch yields an empty array, and
    // `= ANY('{}')` matches nothing — fail-closed, which is the correct answer
    // (they are scoped to zero branches), never "fall back to tenant-wide".
    const branchIds = branchScope.branchIds;
    if (branchIds !== null) qb.setParameter('scopeBranchIds', branchIds);

    // A caller with `read_own` and no staff profile of their own sees 0 — the
    // same answer `AppointmentService.findAll` gives, not "all appointments".
    if (grants.appointments === 'ALL' || ownStaffId) {
      const sub = this.appointments
        .createQueryBuilder('a')
        .select('COUNT(*)')
        .where(`a."${this.fk(this.appointments, 'tenant')}" = :tenantId`);
      if (ownStaffId) {
        sub.andWhere(
          `a."${this.fk(this.appointments, 'staff')}" = :ownStaffId`,
        );
        qb.setParameter('ownStaffId', ownStaffId);
      }
      if (branchIds !== null) {
        // `appointments.branchId` is NOT NULL and already covered by the
        // `(tenantId, branchId, start_at)` index, so this narrows the same
        // index scan rather than adding work.
        sub.andWhere(
          `a."${this.fk(this.appointments, 'branch')}" = ANY(:scopeBranchIds)`,
        );
      }
      add(`(${sub.getQuery()})`, 'appointments');

      // `myPatients` — distinct customers across the SAME appointment scope
      // as the count immediately above (own-staff + branch, when applicable).
      // Deliberately a separate sub-select, not `COUNT(DISTINCT ...)` folded
      // into the one above: the two answer different questions ("how many
      // appointments" vs. "how many distinct patients") and must remain
      // independently readable if a future caller can see one but not the
      // other. Reuses the identical bound parameters — `:tenantId`,
      // `:ownStaffId`, `:scopeBranchIds` — never re-derives them, so this
      // can never drift from the scope `appointments` itself just applied.
      const patientsSub = this.appointments
        .createQueryBuilder('a')
        .select(`COUNT(DISTINCT a."${this.fk(this.appointments, 'customer')}")`)
        .where(`a."${this.fk(this.appointments, 'tenant')}" = :tenantId`);
      if (ownStaffId) {
        patientsSub.andWhere(
          `a."${this.fk(this.appointments, 'staff')}" = :ownStaffId`,
        );
      }
      if (branchIds !== null) {
        patientsSub.andWhere(
          `a."${this.fk(this.appointments, 'branch')}" = ANY(:scopeBranchIds)`,
        );
      }
      add(`(${patientsSub.getQuery()})`, 'myPatients');
    }

    if (grants.customers) {
      // NOT branch-narrowed: `customers` has no branch column. A patient
      // belongs to the clinic, not to a location, and can be seen at any of
      // them. Deriving "customers of my branch" would mean an EXISTS join
      // through `appointments` — a different, weaker question ("has ever had
      // an appointment here") on every dashboard load. Left tenant-wide
      // deliberately, and stated here rather than left to be discovered:
      // `crm.customers.read` is a tenant-wide grant for this role today.
      const sub = this.customers
        .createQueryBuilder('c')
        .select('COUNT(*)')
        .where(`c."${this.fk(this.customers, 'tenant')}" = :tenantId`);
      add(`(${sub.getQuery()})`, 'customers');
    }

    if (grants.staff) {
      const sub = this.staff
        .createQueryBuilder('s')
        .select('COUNT(*)')
        .where(`s."${this.fk(this.staff, 'tenant')}" = :tenantId`);
      if (branchIds !== null) {
        // Staff carry no branch column of their own — the assignment lives on
        // `branch_users`, keyed by the staff profile's USER. An EXISTS is the
        // right shape here (not a join): it stops at the first matching row
        // and cannot multiply the count for someone assigned to two branches,
        // which a join would silently do.
        sub.andWhere(
          `EXISTS (
             SELECT 1 FROM branch_users bu
              WHERE bu."userId" = s."${this.fk(this.staff, 'user')}"
                AND bu."branchId" = ANY(:scopeBranchIds)
           )`,
        );
      }
      add(`(${sub.getQuery()})`, 'staff');
    }

    if (grants.handovers) {
      // NOT branch-narrowed: `handover_requests` has no branch column either
      // (a WhatsApp conversation is not bound to a location). Tenant-wide by
      // necessity, not by oversight.
      const sub = this.handovers
        .createQueryBuilder('h')
        .select('COUNT(*)')
        .where(`h."${this.fk(this.handovers, 'tenant')}" = :tenantId`)
        .andWhere('h.status = :pendingStatus');
      qb.setParameter('pendingStatus', HANDOVER_STATUS.PENDING);
      add(`(${sub.getQuery()})`, 'pendingHandovers');
    }

    // A caller permitted to read none of the four costs zero database work.
    // `appointments` still resolves to a number rather than null when the
    // caller HOLDS `read_own` but owns no staff profile: that is a real,
    // knowable answer — zero — and it is the same one
    // `AppointmentService.findAll` gives them today. `null` is reserved for
    // "you may not ask".
    const row = selected
      ? await qb.getRawOne<Record<string, string | null>>()
      : undefined;

    const read = (key: string, allowed: boolean): number | null =>
      allowed ? Number(row?.[key] ?? 0) : null;

    return {
      appointments: read('appointments', grants.appointments !== 'NONE'),
      myPatients: read('myPatients', grants.appointments !== 'NONE'),
      customers: read('customers', grants.customers),
      staff: read('staff', grants.staff),
      pendingHandovers: read('pendingHandovers', grants.handovers),
    };
  }
}
