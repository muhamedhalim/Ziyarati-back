import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository } from 'typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { PERMISSION } from '../../rbac/rbac.constants';
import {
  AnalyticsCacheService,
  CACHE_NS,
} from '../analytics/analytics-cache.service';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { HANDOVER_STATUS } from '../ai/ai.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

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
  staff: number | null;
  pendingHandovers: number | null;
  /** Echoes what the caller was actually allowed to see — never client-guessed. */
  scope: {
    appointments: 'ALL' | 'OWN' | 'NONE';
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
    private readonly cache: AnalyticsCacheService,
    private readonly access: AccessControlService,
  ) {}

  async get(
    tenantId: string,
    user: AuthenticatedUser,
  ): Promise<DashboardSummary> {
    const grants = await this.resolveGrants(tenantId, user);

    // `appointments.read_own` narrows the count to the caller's own staff
    // profile, so the cached value must be keyed by that caller — never shared
    // with the tenant-wide count. Everyone holding the tenant-wide permission
    // shares one entry.
    const ownStaffId =
      grants.appointments === 'OWN'
        ? await this.resolveCallerStaffId(tenantId, user.id)
        : null;

    const suffix = this.cacheSuffix(grants, ownStaffId);

    const counts = await this.cache.wrap(
      tenantId,
      CACHE_NS.DASHBOARD,
      suffix,
      () => this.countAll(tenantId, grants, ownStaffId),
    );

    return {
      ...counts,
      scope: { appointments: grants.appointments },
      generatedAt: new Date().toISOString(),
    };
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

  /** The caller's own StaffProfile id — mirrors `AppointmentService`'s own scoping. */
  private async resolveCallerStaffId(
    tenantId: string,
    userId: string,
  ): Promise<string | null> {
    const profile = await this.staff.findOne({
      where: { user: { id: userId }, tenant: { id: tenantId } },
      select: { id: true },
    });
    return profile?.id ?? null;
  }

  /**
   * Cache key must encode the caller's VISIBILITY, or a receptionist's cached
   * response could be served to a doctor whose scope is narrower.
   */
  private cacheSuffix(grants: Grants, ownStaffId: string | null): string {
    const parts = [
      `a:${grants.appointments === 'OWN' ? `own:${ownStaffId ?? 'none'}` : grants.appointments}`,
      `c:${grants.customers ? 1 : 0}`,
      `s:${grants.staff ? 1 : 0}`,
      `h:${grants.handovers ? 1 : 0}`,
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
  ): Promise<Omit<DashboardSummary, 'scope' | 'generatedAt'>> {
    const qb = this.tenants
      .createQueryBuilder('t')
      .where('t.id = :tenantId', { tenantId });

    let selected = false;
    const add = (sql: string, alias: string) => {
      qb[selected ? 'addSelect' : 'select'](sql, alias);
      selected = true;
    };

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
      add(`(${sub.getQuery()})`, 'appointments');
    }

    if (grants.customers) {
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
      add(`(${sub.getQuery()})`, 'staff');
    }

    if (grants.handovers) {
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
      customers: read('customers', grants.customers),
      staff: read('staff', grants.staff),
      pendingHandovers: read('pendingHandovers', grants.handovers),
    };
  }
}
