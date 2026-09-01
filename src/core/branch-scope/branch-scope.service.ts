import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { AppRedisService } from '../../queue/app-redis.service';
import { AppError, ErrorCode } from '../../common/errors';
import { isBranchRestricted } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../../modules/auth/interfaces/authenticated-user.interface';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/**
 * Bounds staleness of the branch-membership cache (FND-017): a staff member
 * reassigned to a different branch may still see their PREVIOUS branch — or
 * be refused their NEW one — for up to this long.
 *
 * TTL-only (no write-side invalidation on `StaffService.assignBranches`) is
 * the deliberate trade-off inherited from `BranchService`, where this cache
 * was first introduced: tenant isolation and possession of the underlying
 * permission are enforced regardless of staleness, so a short TTL is ample
 * without building an invalidation pipeline for one query.
 */
const BRANCH_MEMBERSHIP_CACHE_TTL_SECONDS = 60;

/**
 * The branches a principal may see and act on.
 *
 * `branchIds === null` means TENANT-WIDE — no narrowing at all, which is the
 * answer for every role that exists today except a branch-restricted one.
 * An EMPTY array means "restricted, but assigned to no branch": a real,
 * fail-closed answer (sees nothing), never silently widened to tenant-wide.
 */
export interface BranchScope {
  branchIds: string[] | null;
}

/** Convenience: tenant-wide, allocated once (this object is never mutated). */
const TENANT_WIDE: BranchScope = Object.freeze({ branchIds: null });

/**
 * ============================================================================
 *  THE branch-scope authority
 * ============================================================================
 *
 * Sibling of {@link TenantContextService}: that one answers "which tenant is
 * this request running under?", this one answers "which branches inside it may
 * this principal touch?". Both are singletons injectable anywhere.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Before this service, "which branches is this user assigned to" was written
 * THREE times — `BranchService.resolveOwnBranchIds` (Redis-cached, but with no
 * consumer outside its own module), `AdvancedAnalyticsService.resolveScope`
 * and `PatientQueueService.resolveOwnBranchIds` (both uncached, each with its
 * own subtly different rule for *when* the narrowing applies). Three copies of
 * an authorization primitive is three chances for one of them to drift open.
 * All three now delegate here; the Redis cache moved with the query, so the
 * two that had none gain it.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * Whether a principal is narrowed at all is decided by
 * {@link isBranchRestricted} — a PERMISSION predicate in the RBAC contract,
 * not a role allow-list here. That is what lets a tenant "Other" custom role
 * delegated `branches.update_own` be scoped automatically, and what keeps
 * owner/manager/receptionist/doctor/ai-bot behaviour byte-identical to before.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * A branch id from the client is NEVER trusted. Callers either pass the
 * resolved `branchIds` straight into a `WHERE`, or run a requested id through
 * {@link assertBranchAllowed} first. There is no code path where a
 * request-supplied branch widens a scope.
 */
@Injectable()
export class BranchScopeService {
  constructor(
    @InjectRepository(BranchUser)
    private readonly branchUsers: Repository<BranchUser>,
    private readonly redis: AppRedisService,
    private readonly context: TenantContextService,
  ) {}

  /**
   * The branch ids `userId` is assigned to via `branch_users`, Redis-cached
   * with a tenant-qualified key (PR-006) so an ABAC check costs at most one
   * scoped read per {@link BRANCH_MEMBERSHIP_CACHE_TTL_SECONDS} window.
   *
   * Fails open to a real database read on any cache error — `AppRedisService`
   * already fails open at the connection level, and this call site must never
   * turn a Redis hiccup into a 500.
   *
   * This is MEMBERSHIP only. It says nothing about whether the caller is
   * restricted — `PatientQueueService` deliberately uses membership alone
   * (its own FR-Q014 rule: "assigned to a branch ⇒ confined to it"), while
   * {@link resolve} layers the RBAC predicate on top.
   */
  async getMembershipBranchIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    const cacheKey = `branch-membership:${tenantId}:${userId}`;
    const cached = await this.redis.application.get(cacheKey).catch(() => null);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as string[];
      } catch {
        // Corrupt cache entry — fall through to a real read below.
      }
    }

    const rows = await this.branchUsers.find({
      where: { tenant: { id: tenantId }, user: { id: userId } },
      relations: { branch: true },
    });
    // Deterministic (id-ordered): a restricted caller with several assigned
    // branches must produce the SAME scope — and therefore the same cache
    // key downstream — on every request, never an order that varies.
    const branchIds = rows.map((r) => r.branch.id).sort();

    await this.redis.application
      .set(
        cacheKey,
        JSON.stringify(branchIds),
        'EX',
        BRANCH_MEMBERSHIP_CACHE_TTL_SECONDS,
      )
      .catch(() => undefined);
    return branchIds;
  }

  /**
   * The authoritative scope for an explicit principal.
   *
   * Returns tenant-wide for anything that is not branch-restricted per the
   * RBAC predicate — including a `null` principal (worker jobs, patient
   * self-service, public booking), which is correct: those are not
   * branch-restricted staff members and must not be narrowed by accident.
   */
  async resolve(
    tenantId: string,
    user: Pick<AuthenticatedUser, 'id' | 'permissions'> | null | undefined,
  ): Promise<BranchScope> {
    if (!user || !isBranchRestricted(user.permissions)) return TENANT_WIDE;
    return { branchIds: await this.getMembershipBranchIds(tenantId, user.id) };
  }

  /**
   * The ambient equivalent of {@link resolve}, for chokepoints deep inside a
   * service where threading the principal through every caller would mean
   * changing a dozen unrelated signatures (e.g.
   * `AppointmentService.loadForWrite`, reached from six mutation methods, two
   * of which also run for patients with no principal at all).
   *
   * Reads the SAME request-scoped principal `TenantContextInterceptor` already
   * publishes — the mechanism `TenantContextService.requireTenantId()` relies
   * on in every controller — so this is not a second source of identity.
   * Outside a request (a worker job) the store's `user` is `null` and the
   * result is tenant-wide, exactly as {@link resolve} would answer.
   *
   * Prefer {@link resolve} wherever the principal is already in hand.
   */
  resolveCurrent(tenantId: string): Promise<BranchScope> {
    return this.resolve(tenantId, this.context.getUser());
  }

  /** True when `scope` permits `branchId`. Tenant-wide permits everything. */
  isAllowed(scope: BranchScope, branchId: string | null | undefined): boolean {
    if (scope.branchIds === null) return true;
    return !!branchId && scope.branchIds.includes(branchId);
  }

  /**
   * Rejects a branch the caller may not reach.
   *
   * 403 rather than 404 because the id here is one the client explicitly
   * asked for (a filter or a body field) and the branch list itself is
   * readable by any staff member of the tenant — there is nothing to conceal,
   * and a clear refusal is the better answer. Reads that resolve a branch
   * from a RECORD id (e.g. one appointment) 404 instead, so a foreign record
   * stays indistinguishable from a non-existent one.
   */
  assertBranchAllowed(
    scope: BranchScope,
    branchId: string | null | undefined,
  ): void {
    if (this.isAllowed(scope, branchId)) return;
    throw new AppError(ErrorCode.PERMISSION_DENIED, {
      message: 'You can only access branches you are assigned to',
      publicContext: { reason: 'BRANCH_OUT_OF_SCOPE' },
    });
  }

  /**
   * A TypeORM `where` fragment for a `branch` relation, or `undefined` when
   * the caller is tenant-wide (so the property is simply not added).
   *
   * Keeps every call site from re-deciding how to express "one branch vs.
   * several vs. none" — and, importantly, makes the empty-scope case
   * (`In([])`, which matches nothing) impossible to forget.
   */
  branchFilter(scope: BranchScope): { id: ReturnType<typeof In> } | undefined {
    if (scope.branchIds === null) return undefined;
    return { id: In(scope.branchIds) };
  }
}
