import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppRedisService } from '../../queue/app-redis.service';
import { AppError, ErrorCode } from '../../common/errors';
import { isStatusWriteScopedToOwnStaff } from '../../rbac/rbac.constants';
import { TenantContextService } from '../tenant-context/tenant-context.service';

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
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    private readonly redis: AppRedisService,
    private readonly context: TenantContextService,
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

  /**
   * Whether the ambient principal must be confined to appointments assigned to
   * its OWN StaffProfile when it DRIVES one (queue actions, status changes) —
   * `isStatusWriteScopedToOwnStaff` applied to the request-scoped principal
   * (`TenantContextService`, the same source `BranchScopeService.resolveCurrent`
   * reads). A request with no principal (worker job, payment listener,
   * patient self-service) is never confined.
   */
  isCurrentPrincipalStatusWriteScoped(): boolean {
    const user = this.context.getUser();
    return !!user && isStatusWriteScopedToOwnStaff(user.permissions);
  }

  /**
   * THE write-side ownership gate for driving an appointment (queue check-in /
   * call / start / complete / skip / recall / no-show, and
   * `POST /appointments/:id/status`).
   *
   * Resolves to `true` when the principal IS confined to its own appointments
   * and this one is its own; to `false` when the principal is not confined at
   * all (nothing was checked — and no query was run). Throws the SAME
   * `NOT_FOUND "Appointment not found"` an own-scoped read returns when a
   * confined principal targets someone else's appointment (or owns no
   * StaffProfile at all — fail-closed, see the class docblock), so another
   * provider's appointment is indistinguishable from a non-existent one.
   *
   * `appointmentStaffId` must be the appointment's CURRENT assigned staff
   * (`appointment.staff.id`), never a snapshot copied elsewhere (e.g.
   * `QueueEntry.staff`, which goes stale on reassignment). `notFoundMessage`
   * lets a caller that addresses the record by a different id (a queue entry)
   * use the message its own "does not exist" branch uses, so the refusal stays
   * byte-identical to a genuine miss.
   */
  async assertMayDriveAppointment(
    tenantId: string,
    appointmentStaffId: string | null | undefined,
    notFoundMessage = 'Appointment not found',
  ): Promise<boolean> {
    const user = this.context.getUser();
    if (!user || !isStatusWriteScopedToOwnStaff(user.permissions)) return false;

    const ownStaffId = await this.resolveOwnStaffId(tenantId, user.id);
    if (!ownStaffId || ownStaffId !== appointmentStaffId) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: notFoundMessage });
    }
    return true;
  }

  /**
   * Whether `userId`'s StaffProfile has at least one (non-deleted) appointment
   * with `customerId` in `tenantId` — the "provider ↔ patient" relationship
   * that scopes `crm.customers.update_own`.
   *
   * Derived from appointments ONLY, on purpose: appointments are created by
   * front-desk/owner roles, never by the doctor, so a doctor cannot mint the
   * relationship for themselves. (A clinical-entry-authorship link would be
   * self-grantable — a doctor may write an entry on any tenant patient.) Any
   * appointment status counts; soft-deleted rows are excluded by TypeORM's
   * default. A caller with no StaffProfile owns no patients (fail-closed).
   */
  async hasAppointmentWithCustomer(
    tenantId: string,
    userId: string,
    customerId: string,
  ): Promise<boolean> {
    const ownStaffId = await this.resolveOwnStaffId(tenantId, userId);
    if (!ownStaffId) return false;
    return this.appointments.exists({
      where: {
        tenant: { id: tenantId },
        staff: { id: ownStaffId },
        customer: { id: customerId },
      },
    });
  }
}
