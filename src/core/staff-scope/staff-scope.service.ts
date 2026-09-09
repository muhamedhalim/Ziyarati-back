import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { AppRedisService } from '../../queue/app-redis.service';

/**
 * Bounds staleness of the own-StaffProfile cache, mirroring
 * `BranchScopeService`'s own constant and rationale:
 * a staff member's account is essentially never relinked to a different
 * StaffProfile, so a short TTL is ample without building an invalidation
 * pipeline for a value that almost never changes.
 */
const OWN_STAFF_CACHE_TTL_SECONDS = 60;

/**
 * ============================================================================
 *  THE "current caller's own StaffProfile" authority
 * ============================================================================
 *
 * Sibling of {@link BranchScopeService} (`src/core/branch-scope`): that one
 * answers "which branches may this principal touch?", this one answers
 * "which StaffProfile, if any, IS this principal?".
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Before this service, "resolve the caller's own StaffProfile id" was written
 * TWICE — `AppointmentService.resolveCallerStaffId` and
 * `DashboardSummaryService.resolveCallerStaffId` (an explicit, acknowledged
 * mirror of the first) — both uncached, both backing the exact same
 * `appointments.read_own` ownership scope (see OWNERSHIP_SCOPED_PERMISSIONS
 * in rbac.constants.ts). A third and fourth consumer (the patient queue, the
 * staff module's own-schedule read) are what tipped this into a shared
 * primitive rather than a third and fourth copy.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A `StaffProfile` is looked up by `(user.id, tenant.id)` — the ONLY link
 * between a login account and a staff record (`StaffProfile.user`, a 1:1). A
 * caller with no StaffProfile in this tenant (an Owner/Manager account, most
 * commonly) legitimately owns nothing: this resolves to `null`, never throws.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────
 * `null` means "owns zero rows" and every consumer MUST treat it as a
 * fail-closed empty result — the same discipline
 * `OWNERSHIP_SCOPED_PERMISSIONS`'s doc comment requires of every "_own"
 * permission. Never treat `null` as "unscoped" / "see everything".
 */
@Injectable()
export class StaffScopeService {
  constructor(
    @InjectRepository(StaffProfile)
    private readonly staffProfiles: Repository<StaffProfile>,
    private readonly redis: AppRedisService,
  ) {}

  /**
   * The StaffProfile id `userId` owns in `tenantId`, or `null` if they own
   * none. Redis-cached with a tenant-qualified key so repeat calls within
   * {@link OWN_STAFF_CACHE_TTL_SECONDS} cost nothing.
   *
   * Fails open to a real database read on any cache error — `AppRedisService`
   * already fails open at the connection level, and this call site must never
   * turn a Redis hiccup into a 500.
   */
  async resolveOwnStaffId(
    tenantId: string,
    userId: string,
  ): Promise<string | null> {
    const cacheKey = `staff-profile:${tenantId}:${userId}`;
    const cached = await this.redis.application.get(cacheKey).catch(() => null);
    if (cached !== null) {
      // A cached "no profile" is stored as the empty string (Redis cannot
      // cache `null` itself) — distinguish it from a genuine cache miss.
      return cached === '' ? null : cached;
    }

    const profile = await this.staffProfiles.findOne({
      where: { user: { id: userId }, tenant: { id: tenantId } },
      select: { id: true },
    });
    const staffId = profile?.id ?? null;

    await this.redis.application
      .set(cacheKey, staffId ?? '', 'EX', OWN_STAFF_CACHE_TTL_SECONDS)
      .catch(() => undefined);
    return staffId;
  }
}
