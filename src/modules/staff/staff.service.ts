import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, ILike, In, Repository } from 'typeorm';

import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffService as StaffServiceEntity } from '../../entities/Staff/StaffService';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { User } from '../../entities/Auth&RBAC/User';
import { Role } from '../../entities/Auth&RBAC/Role';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { Permission } from '../../entities/Auth&RBAC/Permission';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Service } from '../../entities/Services/Service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AppError, ErrorCode } from '../../common/errors';
import { slugify, uniqueSlug } from '../../common/utils/slugify.util';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { QueryStaffDto } from './dto/query-staff.dto';
import { AssignServicesDto } from './dto/assign-services.dto';
import { AssignBranchesDto } from './dto/assign-branches.dto';
import { CreateStaffWithNewUserDto } from './dto/create-staff-with-new-user.dto';

import { AuthService } from '../auth/auth.service';
import { RolesService } from '../auth/roles.service';
import { StorageService } from '../storage/storage.service';
import { UsageService } from '../subscription-billing/usage.service';
import { EmailService } from '../email/email.service';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';
import {
  APPOINTMENT_BOOKABLE_STAFF_ROLES,
  CUSTOM_ROLE_SENTINEL,
  OWNERSHIP_SCOPED_PERMISSIONS,
  PERMISSION,
  PermissionSlug,
  PUBLIC_BOOKING_EXCLUDED_ROLES,
  ROLE,
  RoleSlug,
  isSynthesizedCustomRoleName,
} from '../../rbac/rbac.constants';

/** Staff-facing view of a held role — enough for the Add/Edit role selector. */
export interface StaffRoleDetail {
  id: string;
  slug: string;
  name: string;
  /** True for a synthesized "Other" role — a tenant custom, non-system role. */
  isCustom: boolean;
  /** Present only when `isCustom` — the exact permission slugs it grants. */
  permissionSlugs?: string[];
}

/** Role snapshot recorded in the audit trail — see `StaffService.auditRoleChange`. */
interface AuditRoleSnapshot {
  slug: string;
  name: string;
  isCustom: boolean;
  permissionSlugs?: string[];
}

/**
 * Permission catalogue entry as shown to the Add/Edit Staff role selector —
 * backs both the "Other" checklist (`findAssignablePermissions`) and the
 * predefined-role permissions preview (`findAssignableRolePermissions`), so
 * the two panels render identically. `isOwnershipScoped` mirrors
 * `OWNERSHIP_SCOPED_PERMISSIONS` (rbac.constants.ts) — never re-derived from
 * the slug string on the frontend, since that set is a curated editorial
 * decision, not a naming convention.
 */
export interface AssignablePermissionView {
  id: string;
  slug: string;
  name: string;
  module?: string | null;
  description?: string | null;
  scope?: string;
  isOwnershipScoped: boolean;
}

function toAssignablePermissionView(p: Permission): AssignablePermissionView {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    module: p.module,
    description: p.description ?? null,
    scope: p.scope,
    isOwnershipScoped: OWNERSHIP_SCOPED_PERMISSIONS.has(
      p.slug as PermissionSlug,
    ),
  };
}

/**
 * Staff profile lifecycle + service/branch assignment.
 *
 * ─── TENANT ISOLATION ───────────────────────────────────────────────────────
 * `tenantId` is always supplied by the controller from the authenticated
 * principal (never the body). It is applied on every read (`tenant: { id }`),
 * stamped on every write, and used to re-validate every referenced resource
 * (user, service, branch) so cross-tenant references are impossible.
 */
@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
    @InjectRepository(StaffServiceEntity)
    private readonly staffServices: Repository<StaffServiceEntity>,
    @InjectRepository(BranchUser)
    private readonly branchUsers: Repository<BranchUser>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(Service) private readonly services: Repository<Service>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly rolesService: RolesService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
    private readonly email: EmailService,
    private readonly branchScope: BranchScopeService,
  ) {}

  /** Roles this tenant may assign to staff — backs the Add Staff role selector. */
  async findAssignableRoles(
    tenantId: string,
  ): Promise<{ id: string; slug: string; name: string; bookable: boolean }[]> {
    const roles = await this.rolesService.findAssignableForStaff(tenantId);
    // Slim projection for the dropdown — the full Role (with its permission
    // set) is more than this endpoint needs to expose. `bookable` mirrors
    // appointment-eligible roles, while excluding roles explicitly barred from
    // public booking (such as nurse) through StaffService.resolveBookableFlag.
    return roles.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      bookable:
        (APPOINTMENT_BOOKABLE_STAFF_ROLES as readonly string[]).includes(
          r.slug,
        ) &&
        !(PUBLIC_BOOKING_EXCLUDED_ROLES as readonly string[]).includes(r.slug),
    }));
  }

  /**
   * Permissions the CALLER may grant to a staff member via the "Other" role
   * option — always a subset of the caller's own permissions, never the full
   * catalogue (see `RolesService.findGrantableForCaller`). This is what makes
   * the selector inherently un-escalatable: an option that would 403 on
   * submit is never even offered.
   */
  async findAssignablePermissions(
    callerPermissions: string[],
  ): Promise<AssignablePermissionView[]> {
    const perms =
      await this.rolesService.findGrantableForCaller(callerPermissions);
    return perms.map(toAssignablePermissionView);
  }

  /**
   * The FULL permission set a predefined or custom role grants — never
   * filtered to what the caller holds (unlike `findAssignablePermissions`).
   * Backs the read-only permissions preview shown under the role selector
   * once Doctor/Manager/Receptionist/a tenant custom role is picked, so the
   * clinic owner sees exactly what that role grants before creating the
   * employee. Purely informational — see `RolesService.findAssignableRolePermissions`.
   */
  async findAssignableRolePermissions(
    roleId: string,
    tenantId: string,
  ): Promise<AssignablePermissionView[]> {
    const perms = await this.rolesService.findAssignableRolePermissions(
      roleId,
      tenantId,
    );
    return perms.map(toAssignablePermissionView);
  }

  /**
   * Attaches each profile's currently held role — the receptionist/manager/
   * doctor system role, or the synthesized custom ("Other") role, with its
   * exact permission set — so the Edit Staff dialog can prefill the role
   * selector without a second round-trip. Bulk (one query for the whole
   * page, never per row). Assumes the established single-role-per-staff-
   * account model (see StaffAccessService docblock);
   * a user holding more than one role is defensively left with `role: null`
   * here rather than guessing which one to show.
   */
  private async withRoleDetail<T extends StaffProfile>(
    profiles: T[],
  ): Promise<(T & { role?: StaffRoleDetail | null })[]> {
    const userIds = profiles.map((p) => p.user?.id).filter(Boolean) as string[];
    if (userIds.length === 0) return profiles;

    const links = await this.userRoles.find({
      where: { user: { id: In(userIds) } },
      relations: {
        user: true,
        role: { rolePermissions: { permission: true } },
      },
    });

    const byUser = new Map<string, UserRole[]>();
    for (const link of links) {
      if (!link.user) continue;
      const list = byUser.get(link.user.id) ?? [];
      list.push(link);
      byUser.set(link.user.id, list);
    }

    return profiles.map((profile) => {
      const decorated = profile as T & { role?: StaffRoleDetail | null };
      const userLinks = profile.user?.id
        ? byUser.get(profile.user.id)
        : undefined;
      decorated.role =
        userLinks?.length === 1 ? this.toRoleDetail(userLinks[0].role) : null;
      return decorated;
    });
  }

  private toRoleDetail(role: Role): StaffRoleDetail {
    const isCustom = !role.is_system;
    return {
      id: role.id,
      slug: role.slug,
      name: role.name,
      isCustom,
      permissionSlugs: isCustom
        ? (role.rolePermissions ?? [])
            .map((rp) => rp.permission?.slug)
            .filter((s): s is string => Boolean(s))
        : undefined,
    };
  }

  /**
   * Resolves `avatar_storage_key` into a short-lived signed URL for the
   * response's `avatar_url` field (private bucket — never a stored/public
   * URL). Falls back to the legacy `avatar_url` column for rows created
   * before private storage. Mutates the loaded entity in place; nothing is
   * persisted back to the DB.
   */
  private async withResolvedAvatar<T extends StaffProfile>(
    profile: T,
    tenantId: string,
  ): Promise<T> {
    if (profile.avatar_storage_key) {
      profile.avatar_url = await this.storage.getSignedDownloadUrl(
        profile.avatar_storage_key,
        tenantId,
      );
    }
    return profile;
  }

  // ───────────────────────────── Profile CRUD ────────────────────────────── //

  /**
   * Marketplace BE-2 (T060) — assigns `public_slug` for a NEW staff profile.
   * Pre-check narrows the candidate (queries only `base`/`base-%` rows, not
   * the whole table); the actual race-safety backstop is the caller's own
   * retry-on-`UQ_staff_profiles_public_slug`-violation loop around the
   * INSERT, since two concurrent requests could both pass this pre-check for
   * the same candidate.
   */
  private async generatePublicSlug(
    fullName: string | undefined | null,
  ): Promise<string> {
    const base = slugify(fullName ?? '', 'doctor');
    const rows: { public_slug: string }[] = await this.dataSource.query(
      `SELECT public_slug FROM staff_profiles WHERE public_slug = $1 OR public_slug LIKE $2`,
      [base, `${base}-%`],
    );
    const taken = new Set(rows.map((r) => r.public_slug));
    return uniqueSlug(base, (candidate) => taken.has(candidate));
  }

  /**
   * The write-time half of {@link PUBLIC_BOOKING_EXCLUDED_ROLES} (see its
   * own docblock in rbac.constants.ts): forces `is_available_for_booking`
   * back to `false` for any role that must never appear on the public/
   * AI-booking surfaces, regardless of what the request asked for. A
   * `false` request is never widened — this only ever narrows.
   *
   * Consulted by every path that can set the flag to `true`: `create`,
   * `createWithNewUser`, `update` (both the direct flag change and after a
   * role change — see the reconciliation pass there) and `setAvailability`
   * (which turns this into an explicit 422 instead, a single-purpose
   * endpoint where silently ignoring the request would be surprising).
   */
  private resolveBookableFlag(
    roleSlugs: readonly string[],
    requested: boolean,
  ): boolean {
    if (!requested) return false;
    const excluded: readonly string[] = PUBLIC_BOOKING_EXCLUDED_ROLES;
    return !roleSlugs.some((slug) => excluded.includes(slug));
  }

  /**
   * Re-derives `is_available_for_booking` from the staff member's CURRENT
   * role(s) and forces it to `false` if that role is publicly-booking-
   * excluded — the reconciliation pass `update()` runs after a role change
   * (or a direct flag change) so "switch a profile TO nurse" always wins
   * over a `true` the request set (or left in place from before). A no-op
   * (no extra write) whenever the flag is already `false`.
   */
  private async enforceBookableFlagInvariant(
    tenantId: string,
    staffId: string,
  ): Promise<void> {
    const profile = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
      relations: { user: true },
    });
    if (!profile?.user || !profile.is_available_for_booking) return;
    const roles = await this.rolesService.listUserRoles(
      profile.user.id,
      tenantId,
    );
    const slugs = roles.map((r) => r.slug);
    if (!this.resolveBookableFlag(slugs, true)) {
      await this.staff.update(
        { id: staffId },
        { is_available_for_booking: false },
      );
    }
  }

  /**
   * "Create new staff user" — the Add Staff Member path that provisions the
   * User account AND the StaffProfile together, atomically. Reuses
   * `AuthService.createUserWithRole` for the account/role half so the exact
   * same hashing, role-assignment and tenant-scoping logic that
   * `POST /auth/register-user` uses applies here too — no duplicated
   * business logic.
   *
   * The temporary password is generated server-side and returned ONCE in the
   * response; it is never stored in plaintext and can't be retrieved again
   * (mirrors how every other credential in this codebase is handled — see
   * AuthService.validateCredentials). The same password is also emailed to
   * the new hire (see `sendCredentialsEmail`) once the transaction commits —
   * best-effort, so a mail outage never blocks account creation.
   *
   * `options.sendCredentialsByEmail` (default `true`) lets a caller that has
   * its OWN onboarding email opt out — e.g. `IntegrationStaffProvisioningService
   * .approve()` deliberately discards this same temporary password and sends
   * a set-password invitation instead (see that file's class doc); it must
   * pass `false` or its externally-sourced, unverified email address would
   * receive a live plaintext credential the platform's normal flow never
   * exposes. Named (not positional) specifically so a future parameter added
   * before it can never silently shift into this security-sensitive flag.
   */
  async createWithNewUser(
    tenantId: string,
    dto: CreateStaffWithNewUserDto,
    callerPermissions: string[] = [],
    actorUserId?: string,
    options: { sendCredentialsByEmail?: boolean } = {},
  ): Promise<{ profile: StaffProfile; temporaryPassword: string }> {
    const { sendCredentialsByEmail = true } = options;
    const isCustom = dto.roleSlug === CUSTOM_ROLE_SENTINEL;

    // Resolve/validate the role BEFORE opening any transaction — pure reads,
    // so a doomed request (privileged role, unknown/reserved/un-held
    // permission) fails fast without ever starting one. Dynamic + backend-
    // enforced: any of the tenant's own custom roles or a system role works,
    // EXCEPT founding/platform/non-staff roles (see
    // RolesService.findAssignableRoleBySlug) — never a static manager/
    // receptionist allow-list, so a forced API call can't smuggle one in
    // either. `roleSlug === CUSTOM_ROLE_SENTINEL` ("Other") instead validates
    // a caller-supplied permission set (RolesService.validateCustomPermissions)
    // — the actual custom Role row (+ role_permissions) is created ONLY
    // inside the transaction below via `resolveCustomRole`, so user + staff
    // profile + custom role + role_permissions + user_role all commit or roll
    // back TOGETHER, never a partially-created custom role left behind.
    const catalogueRole = isCustom
      ? null
      : await this.rolesService.findAssignableRoleBySlug(
          dto.roleSlug ?? ROLE.RECEPTIONIST,
          tenantId,
        );
    const customPerms = isCustom
      ? await this.rolesService.validateCustomPermissions(
          dto.permissionSlugs,
          callerPermissions,
        )
      : null;

    if (
      dto.primaryBranchId &&
      !(dto.branchIds ?? []).includes(dto.primaryBranchId)
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'primaryBranchId must be one of branchIds',
      });
    }

    const email = dto.email.trim().toLowerCase();
    // D7 — email uniqueness is enforced globally inside
    // AuthService.createUserWithRole (the shared chokepoint every user
    // creation path routes through, including this one below); no
    // tenant-scoped pre-check is needed here anymore.

    if (dto.avatarStorageKey) {
      this.storage.assertKeyBelongsToTenant(dto.avatarStorageKey, tenantId);
    }

    const temporaryPassword = randomBytes(9).toString('base64url'); // 12 chars

    let assignedRole!: Role;
    const { profileId, userId } = await this.dataSource.transaction(
      async (manager) => {
        // Plan limit: max_users — same rule POST /auth/register-user
        // enforces, via the SAME atomic (tenant-row-locked) check (FND-007)
        // — INSIDE this transaction, before the insert.
        await this.usage.assertUserSeatWithinLimit(tenantId, manager);

        // User creation, custom-role creation, role-permission assignment
        // and user-role assignment all happen inside THIS one transaction.
        assignedRole = isCustom
          ? await this.rolesService.resolveCustomRole(
              tenantId,
              customPerms!,
              null,
              dto.fullName,
              manager,
            )
          : catalogueRole!;

        const user = await this.authService.createUserWithRole(
          manager,
          {
            email,
            password: temporaryPassword,
            fullName: dto.fullName,
            phone: dto.phone,
          },
          assignedRole,
          tenantId,
        );

        // Marketplace BE-2 (T060): this insert lives inside the same
        // transaction as the new User row, so it cannot retry-on-conflict
        // the way `create()`'s standalone insert does (a failed statement
        // aborts the whole Postgres transaction) — the live pre-check in
        // `generatePublicSlug` is the collision-avoidance here; a genuinely
        // simultaneous race on this rarer "create user + staff together"
        // path surfaces as an ordinary failed request the caller retries,
        // not a silent data-integrity issue.
        const publicSlug = await this.generatePublicSlug(dto.fullName);
        // Public-booking exclusion (write-time invariant) — `assignedRole`
        // is resolved above, in THIS same transaction, so it is always the
        // role the new profile is about to hold.
        const bookable = this.resolveBookableFlag(
          [assignedRole.slug],
          dto.isAvailableForBooking ?? true,
        );
        const profile = await manager.save(
          manager.getRepository(StaffProfile).create({
            tenant: { id: tenantId } as Tenant,
            user: { id: user.id } as User,
            title: dto.title,
            bio: dto.bio,
            avatar_storage_key: dto.avatarStorageKey,
            booking_buffer_minutes: dto.bookingBufferMinutes ?? 0,
            is_available_for_booking: bookable,
            public_slug: publicSlug,
          }),
        );

        if (dto.branchIds?.length) {
          const found = await manager.getRepository(Branch).find({
            where: { id: In(dto.branchIds), tenant: { id: tenantId } },
          });
          if (found.length !== dto.branchIds.length) {
            throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
              message: 'One or more branches were not found in this clinic',
            });
          }

          const primary = dto.primaryBranchId ?? dto.branchIds[0];
          await manager.getRepository(BranchUser).save(
            dto.branchIds.map((branchId) =>
              manager.getRepository(BranchUser).create({
                tenant: { id: tenantId } as Tenant,
                branch: { id: branchId } as Branch,
                user: { id: user.id } as User,
                is_primary: branchId === primary,
              }),
            ),
          );
        }

        return { profileId: profile.id, userId: user.id };
      },
    );

    // Both of these are independent, best-effort, self-contained side effects
    // of the commit above (neither's outcome affects the other, and each
    // swallows its own errors) — run concurrently rather than one after the
    // other. Mail outage or audit-write failure must not roll back an
    // account creation that already committed (mirrors
    // StaffAccessService.sendInvitation). The admin-facing UI already shows
    // this same password once, so email delivery failing here degrades the
    // flow, it doesn't block it.
    const postCommit: Promise<unknown>[] = [];
    if (sendCredentialsByEmail) {
      postCommit.push(
        this.sendCredentialsEmail({
          tenantId,
          userId,
          email,
          fullName: dto.fullName,
          temporaryPassword,
          // A synthesized custom role's `name` may embed a DIFFERENT staff
          // member's full name (see RolesService.resolveCustomRole) — it's
          // an admin-facing label, persisted and reusable, so checking
          // `isCustom` (was THIS request the "other" synthesis path) isn't
          // enough: role B created later via `roleSlug: "custom-abc"` reuses
          // the SAME persisted row and would otherwise quote role A's
          // holder's name back at role B's holder. Check the name itself.
          roleName: isSynthesizedCustomRoleName(assignedRole.name)
            ? undefined
            : assignedRole.name,
        }),
      );
    }
    if (actorUserId) {
      postCommit.push(
        this.auditRoleChange({
          tenantId,
          actorUserId,
          targetUserId: userId,
          staffId: profileId,
          action: 'staff.role.assigned',
          previousRole: null,
          newRole: isCustom
            ? {
                slug: assignedRole.slug,
                name: assignedRole.name,
                isCustom: true,
                permissionSlugs: customPerms!.map((p) => p.slug),
              }
            : {
                slug: assignedRole.slug,
                name: assignedRole.name,
                isCustom: false,
              },
        }),
      );
    }
    await Promise.all(postCommit);

    return {
      profile: await this.findOne(tenantId, profileId),
      temporaryPassword,
    };
  }

  /**
   * Emails the same temporary password already shown once in the admin UI,
   * so the new hire can sign in without the admin manually relaying it.
   * Never throws — a delivery failure is logged (without the password) and
   * swallowed, exactly like StaffAccessService.sendInvitation.
   */
  private async sendCredentialsEmail(p: {
    tenantId: string;
    userId: string;
    email: string;
    fullName: string;
    temporaryPassword: string;
    roleName?: string;
  }): Promise<void> {
    try {
      await this.email.sendStaffCredentials({
        to: p.email,
        name: p.fullName,
        role: p.roleName,
        temporaryPassword: p.temporaryPassword,
        loginUrl: this.authService.loginUrl(),
        tenantId: p.tenantId,
        userId: p.userId,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to deliver staff credentials email to user ${p.userId}: ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * `caller` is optional so internal, non-HTTP callers (seeders, jobs) keep
   * working unchanged; omitting it resolves to tenant-wide, exactly as
   * before. The HTTP controller always supplies it.
   */
  async findAll(
    tenantId: string,
    query: QueryStaffDto,
    caller?: { id: string; permissions: string[] },
  ) {
    const where: Record<string, unknown> = { tenant: { id: tenantId } };

    if (query.search) where.title = ILike(`%${query.search}%`);
    if (query.isAvailable !== undefined) {
      where.is_available_for_booking = query.isAvailable === 'true';
    }

    // Branch and role filters both narrow down to a set of allowed user ids;
    // when both are given, the staff member must satisfy both (intersection).
    let allowedUserIds: string[] | null = null;

    // The caller's branch AUTHORIZATION, resolved server-side. Distinct from
    // `query.branchId` below, which is a client-supplied convenience filter:
    // a requested branch outside the scope is refused rather than applied, so
    // a branch-restricted caller can never enumerate another branch's roster
    // by guessing a branch id.
    const branchScope = await this.branchScope.resolve(
      tenantId,
      caller ?? null,
    );
    if (query.branchId) {
      this.branchScope.assertBranchAllowed(branchScope, query.branchId);
    }

    // Branch filter resolves through the branch_users join. The requested
    // branch narrows within the scope; with none requested, the scope itself
    // is the filter. A tenant-wide caller with no `branchId` skips both and
    // runs the exact query they ran before.
    const branchIdsToMatch = query.branchId
      ? [query.branchId]
      : branchScope.branchIds;
    if (branchIdsToMatch !== null) {
      const links = await this.branchUsers.find({
        where: {
          branch: { id: In(branchIdsToMatch) },
          tenant: { id: tenantId },
        },
        relations: { user: true },
      });
      // De-duplicated: a staff member assigned to two of the caller's
      // branches would otherwise appear twice in the id list.
      allowedUserIds = [...new Set(links.map((l) => l.user.id))];
    }

    // Role filter (e.g. `doctor`) resolves through the user_roles join,
    // scoped by the LINKED USER'S tenant (UserRole itself carries no tenant
    // column) — combined with `where.tenant` on staff_profiles below, a role
    // slug shared by other tenants can never leak a staff member across
    // tenants.
    //
    // `bookable=true` narrows the role filter to the roles that may be booked
    // as an appointment's provider (APPOINTMENT_BOOKABLE_STAFF_ROLES). It is
    // an AND with an explicit `role`: asking for `role=receptionist&bookable=
    // true` yields nothing rather than letting either filter widen the other.
    let roleSlugs: string[] | null = query.role ? [query.role] : null;
    if (query.bookable === 'true') {
      roleSlugs = roleSlugs
        ? roleSlugs.filter((slug) =>
            (APPOINTMENT_BOOKABLE_STAFF_ROLES as readonly string[]).includes(
              slug,
            ),
          )
        : [...APPOINTMENT_BOOKABLE_STAFF_ROLES];
    }
    if (roleSlugs !== null) {
      if (roleSlugs.length === 0) {
        return { data: [], total: 0, page: query.page, limit: query.limit };
      }
      const roleLinks = await this.userRoles.find({
        where: {
          role: { slug: In(roleSlugs) },
          user: { tenant: { id: tenantId } },
        },
        relations: { user: true },
      });
      const roleUserIds = roleLinks.map((l) => l.user.id);
      allowedUserIds =
        allowedUserIds === null
          ? roleUserIds
          : allowedUserIds.filter((id) => roleUserIds.includes(id));
    }

    if (allowedUserIds !== null) {
      if (allowedUserIds.length === 0) {
        return { data: [], total: 0, page: query.page, limit: query.limit };
      }
      where.user = { id: In(allowedUserIds) };
    }

    const [data, total] = await this.staff.findAndCount({
      where,
      relations: { user: true },
      order: { created_at: 'DESC', id: 'DESC' }, // id = stable-pagination tiebreaker
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    await Promise.all(
      data.map((profile) => this.withResolvedAvatar(profile, tenantId)),
    );
    return {
      data: await this.withRoleDetail(data),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Raw load — no avatar resolution. `withResolvedAvatar` mutates
   * `avatar_url` into a presentation-only signed URL; if that mutated
   * instance were ever passed to `.save()` (as `update`/`setAvailability`/
   * `remove` need to, to persist OTHER field changes), the fake signed URL
   * would get written into the `avatar_url` column. Every write path must
   * load through here, never through `findOne`.
   */
  private async loadProfile(
    tenantId: string,
    id: string,
  ): Promise<StaffProfile> {
    const profile = await this.staff.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: {
        user: true,
        staffServices: { service: true },
      },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    return profile;
  }

  async findOne(tenantId: string, id: string): Promise<StaffProfile> {
    const profile = await this.loadProfile(tenantId, id);
    await this.withResolvedAvatar(profile, tenantId);
    const [decorated] = await this.withRoleDetail([profile]);
    return decorated;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateStaffDto,
    callerPermissions: string[] = [],
    actorUserId?: string,
  ): Promise<StaffProfile> {
    const profile = await this.loadProfile(tenantId, id);

    if (dto.title !== undefined) profile.title = dto.title;
    if (dto.bio !== undefined) profile.bio = dto.bio;
    if (dto.bookingBufferMinutes !== undefined) {
      profile.booking_buffer_minutes = dto.bookingBufferMinutes;
    }
    if (dto.isAvailableForBooking !== undefined) {
      profile.is_available_for_booking = dto.isAvailableForBooking;
    }

    // Tri-state: omitted = unchanged, null = remove, string = replace. Either
    // way the OLD object (if any) is best-effort deleted from R2 so replacing
    // or removing an avatar doesn't leak orphaned objects.
    //
    // IMPORTANT: TypeORM's `save()` SKIPS `undefined` properties on UPDATE —
    // only an explicit `null` actually clears the column. Assigning
    // `undefined` here would silently no-op and leave the old key in place.
    let previousKey: string | null | undefined;
    if (dto.avatarStorageKey !== undefined) {
      previousKey = profile.avatar_storage_key;
      // The legacy `avatar_url` column must be cleared too — otherwise a
      // stale value left over from before this row adopted the storage-key
      // flow (or from a bug — see the regression test above this one) keeps
      // being returned as a fallback even after the avatar is replaced/removed.
      profile.avatar_url = null;
      if (dto.avatarStorageKey === null) {
        profile.avatar_storage_key = null;
      } else {
        this.storage.assertKeyBelongsToTenant(dto.avatarStorageKey, tenantId);
        profile.avatar_storage_key = dto.avatarStorageKey;
      }
    }

    await this.staff.save(profile);

    if (previousKey && previousKey !== profile.avatar_storage_key) {
      try {
        await this.storage.deleteObject(previousKey, tenantId);
      } catch {
        /* best-effort cleanup — never fail the update over a stale R2 object */
      }
    }

    // Role changes are optional and independent of the profile fields above
    // — omitting `roleSlug` entirely (the common case: editing title/bio/
    // avatar) never touches the account's role or requires `staff.manage`.
    if (dto.roleSlug !== undefined) {
      await this.changeRole(
        tenantId,
        profile,
        dto.roleSlug,
        dto.permissionSlugs,
        callerPermissions,
        actorUserId,
      );
    }

    // Public-booking exclusion (write-time invariant) — run AFTER any role
    // change above, so "switch this profile TO nurse" always wins even when
    // `dto.isAvailableForBooking` was left untouched (the flag it saved
    // earlier in this method reflects the OLD role, not whatever role the
    // account holds now). Only worth the extra read when this request could
    // plausibly have changed bookability at all.
    if (dto.roleSlug !== undefined || dto.isAvailableForBooking !== undefined) {
      await this.enforceBookableFlagInvariant(tenantId, id);
    }

    return this.findOne(tenantId, id);
  }

  /**
   * Reassigns an existing staff member's role — generalizes the "replace
   * whatever role(s) the account holds" semantics StaffAccessService.grant()
   * uses for the fixed receptionist case to any assignable role (including
   * "Other"). Gated on `staff.manage` in addition to the `staff.update` the
   * controller already requires: role/permission changes are more sensitive
   * than a title/bio edit (mirrors how the dashboard-access endpoints, which
   * also change roles, require `staff.manage` rather than `staff.update`).
   * Refuses to touch a super_admin/owner account.
   *
   * Everything that mutates state — synthesizing/reusing the custom role,
   * reassigning `user_roles`, and deleting an orphaned custom role the
   * account just moved off — happens inside ONE transaction. Reusing an
   * existing custom role only ever touches that ONE employee's role (see
   * RolesService.resolveCustomRole/findSoleCustomRole) — editing employee A
   * never mutates employee B's role, even if they were given identical
   * permission sets independently.
   */
  private async changeRole(
    tenantId: string,
    profile: StaffProfile,
    roleSlug: string,
    permissionSlugs: string[] | undefined,
    callerPermissions: string[],
    actorUserId?: string,
  ): Promise<void> {
    if (!callerPermissions.includes(PERMISSION.STAFF_MANAGE)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: "Changing a staff member's role requires staff.manage",
      });
    }

    const userId = profile.user.id;
    const currentRoles = await this.rolesService.listUserRoles(
      userId,
      tenantId,
    );
    const protectedHeld = currentRoles.find((r) =>
      ([ROLE.SUPER_ADMIN, ROLE.OWNER] as RoleSlug[]).includes(
        r.slug as RoleSlug,
      ),
    );
    if (protectedHeld) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Cannot change role for a "${protectedHeld.slug}" account`,
      });
    }

    // Resolve/validate BEFORE the transaction (pure reads/checks) — a doomed
    // request fails fast without ever opening one.
    const isCustom = roleSlug === CUSTOM_ROLE_SENTINEL;
    const catalogueRole = isCustom
      ? null
      : await this.rolesService.findAssignableRoleBySlug(roleSlug, tenantId);
    const customPerms = isCustom
      ? await this.rolesService.validateCustomPermissions(
          permissionSlugs,
          callerPermissions,
        )
      : null;

    // A catalogue role's identity is already known here — skip the
    // transaction entirely (and log nothing) when nothing would change. The
    // custom-role path can't take this shortcut: even re-selecting "Other"
    // on the SAME synthesized role may carry a different permission
    // selection that still needs to be written, so it always proceeds.
    if (
      !isCustom &&
      currentRoles.length === 1 &&
      currentRoles[0].id === catalogueRole!.id
    ) {
      return;
    }

    // Snapshot the PREVIOUS role for the audit trail before anything changes.
    const previousRoleSnapshot =
      currentRoles.length === 1
        ? await this.toAuditRoleSnapshot(currentRoles[0], tenantId)
        : null;

    let assignedRole!: Role;
    let userRoleChanged = false;
    await this.dataSource.transaction(async (manager) => {
      // Custom-role creation/reuse, role-permission assignment and the
      // user_roles reassignment below all happen inside THIS transaction.
      assignedRole = isCustom
        ? await this.rolesService.resolveCustomRole(
            tenantId,
            customPerms!,
            userId,
            profile.user.full_name ?? undefined,
            manager,
          )
        : catalogueRole!;

      // For the custom-role reuse path, `resolveCustomRole` already updated
      // the (reused) role's permissions in place above — nothing further to
      // do unless the account needs to be POINTED at a different role.
      const alreadySoleRole =
        currentRoles.length === 1 && currentRoles[0].id === assignedRole.id;
      if (alreadySoleRole) return;

      userRoleChanged = true;
      await manager.getRepository(UserRole).delete({ user: { id: userId } });
      await manager.getRepository(UserRole).save(
        manager.getRepository(UserRole).create({
          user: { id: userId } as User,
          role: { id: assignedRole.id } as Role,
        }),
      );

      // Correction: when the account moves OFF a role, delete it if it was a
      // tenant custom role and is now orphaned (held by no one else).
      for (const oldRole of currentRoles) {
        if (oldRole.id !== assignedRole.id) {
          await this.rolesService.deleteIfOrphanedCustomRole(oldRole, manager);
        }
      }
    });

    if (userRoleChanged) {
      await this.authService.revokeAllForUser(userId);
    }

    if (actorUserId) {
      await this.auditRoleChange({
        tenantId,
        actorUserId,
        targetUserId: userId,
        staffId: profile.id,
        action: 'staff.role.changed',
        previousRole: previousRoleSnapshot,
        newRole: isCustom
          ? {
              slug: assignedRole.slug,
              name: assignedRole.name,
              isCustom: true,
              permissionSlugs: customPerms!.map((p) => p.slug),
            }
          : {
              slug: assignedRole.slug,
              name: assignedRole.name,
              isCustom: false,
            },
      });
    }
  }

  /** Full audit snapshot of a currently-held role, including permission slugs when custom. */
  private async toAuditRoleSnapshot(
    role: Role,
    tenantId: string,
  ): Promise<AuditRoleSnapshot> {
    if (role.is_system) {
      return { slug: role.slug, name: role.name, isCustom: false };
    }
    const full = await this.rolesService.findOne(role.id, tenantId);
    return {
      slug: full.slug,
      name: full.name,
      isCustom: true,
      permissionSlugs: (full.rolePermissions ?? [])
        .map((rp) => rp.permission?.slug)
        .filter((s): s is string => Boolean(s)),
    };
  }

  /**
   * Best-effort audit trail for role/permission changes — actor, employee,
   * previous role+permissions, new role+permissions. Never fails the
   * triggering operation (mirrors StaffAccessService.audit()'s swallow
   * pattern — auditing must not be able to break staff provisioning).
   */
  private async auditRoleChange(entry: {
    tenantId: string;
    actorUserId: string;
    targetUserId: string;
    staffId: string;
    action: string;
    previousRole: AuditRoleSnapshot | null;
    newRole: AuditRoleSnapshot;
  }): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: { id: entry.tenantId } as Tenant,
          user: { id: entry.actorUserId } as User,
          action: entry.action,
          entity_type: 'staff_profile',
          entity_id: entry.staffId,
          old_values: {
            target_user_id: entry.targetUserId,
            role: entry.previousRole,
          },
          new_values: { role: entry.newRole },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to write audit log for ${entry.action}: ${(err as Error)?.message}`,
      );
    }
  }

  /** Toggles bookability. `active=false` keeps the record but hides it from booking/availability. */
  async setAvailability(
    tenantId: string,
    id: string,
    active: boolean,
  ): Promise<StaffProfile> {
    const profile = await this.loadProfile(tenantId, id);
    // Public-booking exclusion (write-time invariant) — this is a
    // single-purpose, explicit activation endpoint, so an excluded role
    // gets a clear 422 rather than the silent narrowing `create`/
    // `createWithNewUser`/`update` apply on a broader multi-field request.
    if (active && profile.user) {
      const roles = await this.rolesService.listUserRoles(
        profile.user.id,
        tenantId,
      );
      if (
        !this.resolveBookableFlag(
          roles.map((r) => r.slug),
          true,
        )
      ) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            "This staff member's role cannot be made available for public booking",
        });
      }
    }
    profile.is_available_for_booking = active;
    await this.staff.save(profile);
    return this.findOne(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const profile = await this.loadProfile(tenantId, id);
    await this.staff.softRemove(profile);
  }

  // ─────────────────────────── Service mapping ───────────────────────────── //

  /**
   * Replaces the staff member's qualified services. The "qualification" check
   * is the business-rule hook: a service must belong to the clinic and be
   * active before it can be assigned (extend here for licence/skill checks).
   */
  async assignServices(
    tenantId: string,
    staffId: string,
    dto: AssignServicesDto,
  ): Promise<StaffProfile> {
    await this.findOne(tenantId, staffId); // tenant ownership

    await this.dataSource.transaction(async (manager) => {
      if (dto.serviceIds.length) {
        const found = await manager.getRepository(Service).find({
          where: {
            id: In(dto.serviceIds),
            tenant: { id: tenantId },
            is_active: true,
          },
        });
        if (found.length !== dto.serviceIds.length) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message:
              'One or more services were not found, are inactive, or belong to another clinic',
          });
        }
      }

      const repo = manager.getRepository(StaffServiceEntity);
      await repo.delete({ staff: { id: staffId } });

      if (dto.serviceIds.length) {
        await repo.save(
          dto.serviceIds.map((serviceId) =>
            repo.create({
              staff: { id: staffId } as StaffProfile,
              service: { id: serviceId } as Service,
              tenant: { id: tenantId } as Tenant,
            }),
          ),
        );
      }
    });

    return this.findOne(tenantId, staffId);
  }

  async listServices(tenantId: string, staffId: string) {
    await this.findOne(tenantId, staffId);
    return this.staffServices.find({
      where: { staff: { id: staffId }, tenant: { id: tenantId } },
      relations: { service: true },
      order: { created_at: 'ASC' },
    });
  }

  // ─────────────────────────── Branch assignment ─────────────────────────── //

  /** Replaces the staff member's branch assignments (via `branch_users`). */
  async assignBranches(
    tenantId: string,
    staffId: string,
    dto: AssignBranchesDto,
  ): Promise<BranchUser[]> {
    const profile = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
      relations: { user: true },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    const userId = profile.user.id;

    if (dto.primaryBranchId && !dto.branchIds.includes(dto.primaryBranchId)) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'primaryBranchId must be one of branchIds',
      });
    }

    await this.dataSource.transaction(async (manager) => {
      if (dto.branchIds.length) {
        const found = await manager.getRepository(Branch).find({
          where: { id: In(dto.branchIds), tenant: { id: tenantId } },
        });
        if (found.length !== dto.branchIds.length) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message: 'One or more branches were not found in this clinic',
          });
        }
      }

      const repo = manager.getRepository(BranchUser);
      await repo.delete({ user: { id: userId }, tenant: { id: tenantId } });

      if (dto.branchIds.length) {
        const primary = dto.primaryBranchId ?? dto.branchIds[0];
        await repo.save(
          dto.branchIds.map((branchId) =>
            repo.create({
              tenant: { id: tenantId } as Tenant,
              branch: { id: branchId } as Branch,
              user: { id: userId } as User,
              is_primary: branchId === primary,
            }),
          ),
        );
      }
    });

    return this.listBranches(tenantId, staffId);
  }

  async listBranches(tenantId: string, staffId: string): Promise<BranchUser[]> {
    const profile = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
      relations: { user: true },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    return this.branchUsers.find({
      where: { user: { id: profile.user.id }, tenant: { id: tenantId } },
      relations: { branch: true },
      order: { created_at: 'ASC' },
    });
  }
}
