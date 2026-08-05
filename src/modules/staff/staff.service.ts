import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, ILike, In, Not, Repository } from 'typeorm';

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

import { AppError, ErrorCode, isUniqueViolation } from '../../common/errors';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { QueryStaffDto } from './dto/query-staff.dto';
import { AssignServicesDto } from './dto/assign-services.dto';
import { AssignBranchesDto } from './dto/assign-branches.dto';
import { EligibleUsersQueryDto } from './dto/eligible-users-query.dto';
import { CreateStaffWithNewUserDto } from './dto/create-staff-with-new-user.dto';

import { AuthService } from '../auth/auth.service';
import { RolesService } from '../auth/roles.service';
import {
  StaffAccessService,
  type DashboardAccessState,
} from './staff-access.service';
import { StorageService } from '../storage/storage.service';
import { UsageService } from '../subscription-billing/usage.service';
import {
  CUSTOM_ROLE_SENTINEL,
  OWNERSHIP_SCOPED_PERMISSIONS,
  PERMISSION,
  PermissionSlug,
  ROLE,
  RoleSlug,
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
    isOwnershipScoped: OWNERSHIP_SCOPED_PERMISSIONS.has(p.slug as PermissionSlug),
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
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(Service) private readonly services: Repository<Service>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly rolesService: RolesService,
    private readonly access: StaffAccessService,
    private readonly storage: StorageService,
    private readonly usage: UsageService,
  ) {}

  /**
   * Attaches each profile's derived Reception Dashboard access state so the
   * Staff page can render an access column without a second round-trip.
   * Resolved in bulk (one set of queries for the whole page, never per row).
   *
   * Transient/presentation-only — `dashboard_access` is not a column and is
   * never persisted; write paths load through `loadProfile`, which skips this.
   */
  private async withAccessState<T extends StaffProfile>(
    profiles: T[],
  ): Promise<(T & { dashboard_access?: DashboardAccessState })[]> {
    const userIds = profiles.map((p) => p.user?.id).filter(Boolean) as string[];
    const states = await this.access.getAccessStates(userIds);

    return profiles.map((profile) => {
      const decorated = profile as T & {
        dashboard_access?: DashboardAccessState;
      };
      if (profile.user?.id) {
        decorated.dashboard_access = states.get(profile.user.id);
      }
      return decorated;
    });
  }

  /** Roles this tenant may assign to staff — backs the Add Staff role selector. */
  async findAssignableRoles(
    tenantId: string,
  ): Promise<{ id: string; slug: string; name: string }[]> {
    const roles = await this.rolesService.findAssignableForStaff(tenantId);
    // Slim projection for the dropdown — the full Role (with its permission
    // set) is more than this endpoint needs to expose.
    return roles.map((r) => ({ id: r.id, slug: r.slug, name: r.name }));
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
    const perms = await this.rolesService.findGrantableForCaller(callerPermissions);
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
    const perms = await this.rolesService.findAssignableRolePermissions(roleId, tenantId);
    return perms.map(toAssignablePermissionView);
  }

  /**
   * Attaches each profile's currently held role — the receptionist/manager/
   * doctor system role, or the synthesized custom ("Other") role, with its
   * exact permission set — so the Edit Staff dialog can prefill the role
   * selector without a second round-trip. Bulk (one query for the whole
   * page), mirroring {@link withAccessState}. Assumes the established
   * single-role-per-staff-account model (see StaffAccessService docblock);
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
      relations: { user: true, role: { rolePermissions: { permission: true } } },
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
      const userLinks = profile.user?.id ? byUser.get(profile.user.id) : undefined;
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

  async create(tenantId: string, dto: CreateStaffDto): Promise<StaffProfile> {
    const user = await this.users.findOne({
      where: { id: dto.userId, tenant: { id: tenantId } },
    });
    if (!user) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'User not found in this clinic',
      });
    }

    // `user_id` is globally unique on staff_profiles. Include soft-deleted
    // rows here: a deleted profile still owns that user_id in PostgreSQL, so
    // treating it as eligible would only defer the conflict to INSERT.
    const existing = await this.staff.findOne({
      where: { user: { id: dto.userId } },
      withDeleted: true,
    });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This user already has a staff profile',
      });
    }

    if (dto.avatarStorageKey) {
      this.storage.assertKeyBelongsToTenant(dto.avatarStorageKey, tenantId);
    }

    const profile = this.staff.create({
      tenant: { id: tenantId } as Tenant,
      user: { id: dto.userId } as User,
      title: dto.title,
      bio: dto.bio,
      avatar_storage_key: dto.avatarStorageKey,
      booking_buffer_minutes: dto.bookingBufferMinutes ?? 0,
      is_available_for_booking: dto.isAvailableForBooking ?? true,
    });
    let saved: StaffProfile;
    try {
      saved = await this.staff.save(profile);
    } catch (error) {
      // The pre-insert existence check gives a clear response for ordinary
      // duplicate requests. The unique index remains the race-safe backstop
      // when two requests pass that check concurrently.
      if (isUniqueViolation(error)) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'This user already has a staff profile',
        });
      }
      throw error;
    }
    return this.findOne(tenantId, saved.id);
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
   * AuthService.validateCredentials).
   */
  async createWithNewUser(
    tenantId: string,
    dto: CreateStaffWithNewUserDto,
    callerPermissions: string[] = [],
    actorUserId?: string,
  ): Promise<{ profile: StaffProfile; temporaryPassword: string }> {
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
    const existing = await this.users.findOne({
      where: { email, tenant: { id: tenantId } },
    });
    if (existing) {
      throw new AppError(ErrorCode.EMAIL_ALREADY_EXISTS);
    }

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

        const profile = await manager.save(
          manager.getRepository(StaffProfile).create({
            tenant: { id: tenantId } as Tenant,
            user: { id: user.id } as User,
            title: dto.title,
            bio: dto.bio,
            avatar_storage_key: dto.avatarStorageKey,
            booking_buffer_minutes: dto.bookingBufferMinutes ?? 0,
            is_available_for_booking: dto.isAvailableForBooking ?? true,
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

    if (actorUserId) {
      await this.auditRoleChange({
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
          : { slug: assignedRole.slug, name: assignedRole.name, isCustom: false },
      });
    }

    return {
      profile: await this.findOne(tenantId, profileId),
      temporaryPassword,
    };
  }

  async findAll(tenantId: string, query: QueryStaffDto) {
    const where: Record<string, unknown> = { tenant: { id: tenantId } };

    if (query.search) where.title = ILike(`%${query.search}%`);
    if (query.isAvailable !== undefined) {
      where.is_available_for_booking = query.isAvailable === 'true';
    }

    // Branch filter resolves through the branch_users join.
    if (query.branchId) {
      const links = await this.branchUsers.find({
        where: { branch: { id: query.branchId }, tenant: { id: tenantId } },
        relations: { user: true },
      });
      const userIds = links.map((l) => l.user.id);
      if (userIds.length === 0) {
        return { data: [], total: 0, page: query.page, limit: query.limit };
      }
      where.user = { id: In(userIds) };
    }

    const [data, total] = await this.staff.findAndCount({
      where,
      relations: { user: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    await Promise.all(data.map((profile) => this.withResolvedAvatar(profile, tenantId)));
    return {
      data: await this.withRoleDetail(await this.withAccessState(data)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Users this tenant can turn into staff via "Link existing user": active,
   * belong to the tenant, and don't already have a staff profile (including a
   * soft-deleted one, because the one-to-one database constraint still retains
   * that user ID). Two bulk queries rather than per-user staff lookups, so
   * this stays free of N+1 queries while retaining typed repository access.
   */
  async findEligibleUsers(tenantId: string, query: EligibleUsersQueryDto) {
    // This deliberately has no tenant condition: the database relationship is
    // one-to-one globally, so a corrupted cross-tenant row must still prevent
    // this picker from advertising a user that cannot be linked.
    const linked = await this.staff.find({
      relations: { user: true },
      select: { id: true, user: { id: true } },
      withDeleted: true,
    });
    const linkedIds = linked.map((sp) => sp.user.id);

    const base: Record<string, unknown> = {
      tenant: { id: tenantId },
      is_active: true,
      ...(linkedIds.length ? { id: Not(In(linkedIds)) } : {}),
    };

    const where = query.search
      ? [
          { ...base, full_name: ILike(`%${query.search}%`) },
          { ...base, email: ILike(`%${query.search}%`) },
        ]
      : base;

    const [data, total] = await this.users.findAndCount({
      where,
      relations: { userRoles: { role: true } },
      order: { full_name: 'ASC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return {
      data: data.map((user) => ({
        id: user.id,
        fullName: user.full_name ?? null,
        email: user.email ?? null,
        role: user.userRoles?.[0]?.role
          ? { slug: user.userRoles[0].role.slug, name: user.userRoles[0].role.name }
          : null,
      })),
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
    const [withAccess] = await this.withAccessState([profile]);
    const [decorated] = await this.withRoleDetail([withAccess]);
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
    const currentRoles = await this.rolesService.listUserRoles(userId, tenantId);
    const protectedHeld = currentRoles.find((r) =>
      ([ROLE.SUPER_ADMIN, ROLE.OWNER] as RoleSlug[]).includes(r.slug as RoleSlug),
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
    if (!isCustom && currentRoles.length === 1 && currentRoles[0].id === catalogueRole!.id) {
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
          : { slug: assignedRole.slug, name: assignedRole.name, isCustom: false },
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
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
    const userId = profile.user.id;

    if (
      dto.primaryBranchId &&
      !dto.branchIds.includes(dto.primaryBranchId)
    ) {
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
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
    return this.branchUsers.find({
      where: { user: { id: profile.user.id }, tenant: { id: tenantId } },
      relations: { branch: true },
      order: { created_at: 'ASC' },
    });
  }
}
