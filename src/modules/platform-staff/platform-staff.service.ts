import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, In, IsNull, Repository } from 'typeorm';

import { User } from '../../entities/Auth&RBAC/User';
import { Role } from '../../entities/Auth&RBAC/Role';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';

import { AppError, ErrorCode } from '../../common/errors';
import { ROLE, ROLES, RoleSlug } from '../../rbac/rbac.constants';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import { EmailDeliveryService } from '../email/email-delivery.service';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';

import { CreatePlatformStaffDto } from './dto/create-platform-staff.dto';
import { UpdatePlatformStaffDto } from './dto/update-platform-staff.dto';
import { SetPlatformStaffStatusDto } from './dto/set-platform-staff-status.dto';
import { SetPlatformStaffRolesDto } from './dto/set-platform-staff-roles.dto';
import { QueryPlatformStaffDto } from './dto/query-platform-staff.dto';
import {
  PLATFORM_ASSIGNABLE_ROLE_SLUGS,
  isPlatformAssignableRole,
} from './platform-staff.constants';

export type PlatformStaffInvitationStatus =
  | 'no_access'
  | 'invitation_pending'
  | 'invitation_expired'
  | 'invitation_failed'
  | 'active'
  | 'disabled';

/** Template used for both the initial invite and every resend. */
const INVITATION_EMAIL_TEMPLATE = 'staff_invitation';

export interface PlatformStaffSummary {
  id: string;
  email: string | null;
  fullName: string | null;
  phone: string | null;
  isActive: boolean;
  roles: string[];
  lastLoginAt: Date | null;
  invitationStatus: PlatformStaffInvitationStatus;
  createdAt: Date;
}

/**
 * Super Admin management of Platform Customer Service (and any future
 * platform-scope) staff — `users` rows with `tenantId = NULL`.
 *
 * No new table: reuses `users` / `roles` / `user_roles` / `password_resets`,
 * exactly like the clinic-side `StaffAccessService` it mirrors. Every target
 * lookup is scoped to `tenant IS NULL` AND excludes `super_admin` — a tenant
 * user id is indistinguishable from a non-existent one (404, never leaks
 * existence), and a `super_admin` target is always refused outright (this
 * surface can mutate platform STAFF, never the platform operator).
 */
@Injectable()
export class PlatformStaffService {
  private readonly logger = new Logger(PlatformStaffService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
    @InjectRepository(PasswordReset)
    private readonly passwordResets: Repository<PasswordReset>,
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly email: EmailService,
    private readonly emailDelivery: EmailDeliveryService,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  // ────────────────────────────────── Reads ──────────────────────────────── //

  async list(query: QueryPlatformStaffDto): Promise<{
    data: PlatformStaffSummary[];
    total: number;
    page: number;
    limit: number;
  }> {
    const qb = this.users
      .createQueryBuilder('u')
      .where('u."tenantId" IS NULL')
      // Never list the platform operator itself among "staff" — this surface
      // manages platform STAFF, never Super Admin.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM user_roles ur
          INNER JOIN roles r ON r.id = ur."roleId"
          WHERE ur."userId" = u.id AND r.slug = :superAdmin
        )`,
        { superAdmin: ROLE.SUPER_ADMIN },
      );

    if (query.isActive !== undefined) {
      qb.andWhere('u.is_active = :isActive', { isActive: query.isActive });
    }
    if (query.search) {
      const term = `%${query.search}%`;
      qb.andWhere('(u.email ILIKE :term OR u.full_name ILIKE :term)', { term });
    }

    qb.orderBy('u.created_at', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit);

    const [rows, total] = await qb.getManyAndCount();
    const data = await this.decorate(rows);

    return { data, total, page: query.page, limit: query.limit };
  }

  /** Assignable platform roles + their full permission preview (for "Review their permissions"). */
  async listAssignableRoles(): Promise<
    Array<{ slug: string; name: string; permissions: string[] }>
  > {
    const rows = await this.roles.find({
      where: {
        slug: In(PLATFORM_ASSIGNABLE_ROLE_SLUGS as string[]),
        tenant: IsNull(),
      },
      relations: { rolePermissions: { permission: true } },
    });
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      permissions: (r.rolePermissions ?? [])
        .map((rp) => rp.permission?.slug)
        .filter((s): s is string => Boolean(s))
        .sort(),
    }));
  }

  // ──────────────────────────────── Mutations ────────────────────────────── //

  async create(
    dto: CreatePlatformStaffDto,
    actorUserId: string,
  ): Promise<PlatformStaffSummary> {
    const role = await this.roles.findOne({
      where: { slug: dto.roleSlug, tenant: IsNull(), is_system: true },
    });
    if (!role) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND, {
        message: `Platform role "${dto.roleSlug}" is not seeded`,
      });
    }

    const email = dto.email.trim().toLowerCase();
    // Never returned or logged — the account is reached exclusively through
    // the emailed set-password invitation below (24 bytes -> 32 base64url
    // chars, matching StaffService.createWithNewUser's temporary-password
    // entropy).
    const placeholderPassword = randomBytes(24).toString('base64url');

    const userId = await this.dataSource.transaction(async (manager) => {
      // D7 — global email uniqueness (any live user, any tenant, platform
      // included) is enforced INSIDE createUserWithRole; this call is the
      // single chokepoint, so no separate pre-check is needed here.
      const user = await this.authService.createUserWithRole(
        manager,
        {
          email,
          password: placeholderPassword,
          fullName: dto.fullName,
          phone: dto.phone,
        },
        role,
        null,
      );
      return user.id;
    });

    await this.sendInvitation(userId, email, dto.fullName, dto.roleSlug, null);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_CREATE,
      userId: actorUserId,
      entityType: 'PlatformStaff',
      entityId: userId,
      after: { email, fullName: dto.fullName, roleSlug: dto.roleSlug },
    });

    return this.summaryFor(userId);
  }

  async resendInvitation(
    id: string,
    actorUserId: string,
  ): Promise<PlatformStaffSummary> {
    const { user } = await this.loadTarget(id);

    if (user.last_login_at) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This staff member has already signed in; they can use "forgot password" instead',
      });
    }
    if (!user.email) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This staff member has no email address',
      });
    }

    const roleSlug = await this.primaryRoleSlug(id);
    await this.sendInvitation(
      user.id,
      user.email,
      user.full_name ?? undefined,
      roleSlug,
      user.preferred_locale,
    );

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_INVITATION_RESENT,
      userId: actorUserId,
      entityType: 'PlatformStaff',
      entityId: id,
    });

    return this.summaryFor(id);
  }

  async update(
    id: string,
    dto: UpdatePlatformStaffDto,
    actorUserId: string,
  ): Promise<PlatformStaffSummary> {
    const { user } = await this.loadTarget(id);

    const before = {
      fullName: user.full_name ?? null,
      phone: user.phone ?? null,
      preferredLocale: user.preferred_locale ?? null,
    };

    user.full_name = dto.fullName ?? user.full_name;
    user.phone = dto.phone ?? user.phone;
    user.preferred_locale = dto.preferredLocale ?? user.preferred_locale;
    await this.users.save(user);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_UPDATE,
      userId: actorUserId,
      entityType: 'PlatformStaff',
      entityId: id,
      before,
      after: {
        fullName: user.full_name,
        phone: user.phone,
        preferredLocale: user.preferred_locale,
      },
    });

    return this.summaryFor(id);
  }

  /**
   * Activates or deactivates the account. Deactivation additionally revokes
   * every refresh token so a live session dies on its NEXT request — matches
   * StaffAccessService.setEnabled and the guarantee `buildAuthenticatedUser`
   * already gives every request (USER_INACTIVE the instant `is_active` flips).
   */
  async setStatus(
    id: string,
    dto: SetPlatformStaffStatusDto,
    actorUserId: string,
  ): Promise<PlatformStaffSummary> {
    if (id === actorUserId) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'You cannot change your own account status',
      });
    }
    const { user } = await this.loadTarget(id);

    if (user.is_active === dto.isActive) {
      return this.summaryFor(id); // idempotent — no side effect
    }

    await this.users.update({ id }, { is_active: dto.isActive });
    if (!dto.isActive) {
      await this.authService.revokeAllForUser(id);
    }

    await this.audit.record({
      action: dto.isActive
        ? PLATFORM_ADMIN_AUDIT_ACTION.STAFF_ACTIVATE
        : PLATFORM_ADMIN_AUDIT_ACTION.STAFF_DEACTIVATE,
      userId: actorUserId,
      entityType: 'PlatformStaff',
      entityId: id,
      before: { isActive: user.is_active },
      after: { isActive: dto.isActive },
    });

    return this.summaryFor(id);
  }

  /**
   * Replaces the target's full platform role set. Slugs are resolved by
   * SLUG against the hardcoded allow-list, never by a client-supplied role
   * id — `super_admin` can never reach this method (DTO validation already
   * rejects it; this is the backend-enforcement mirror, never trusting the
   * DTO alone).
   */
  async setRoles(
    id: string,
    dto: SetPlatformStaffRolesDto,
    actorUserId: string,
  ): Promise<PlatformStaffSummary> {
    if (id === actorUserId) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'You cannot change your own role assignment',
      });
    }
    const { user, roles: currentRoles } = await this.loadTarget(id);

    const slugs = Array.from(new Set(dto.roleSlugs));
    const invalid = slugs.filter((s) => !isPlatformAssignableRole(s));
    if (invalid.length) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `These roles cannot be assigned through platform staff management: ${invalid.join(', ')}`,
      });
    }

    const roleRows = await this.roles.find({
      where: { slug: In(slugs), tenant: IsNull(), is_system: true },
    });
    if (roleRows.length !== slugs.length) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND, {
        message: 'One or more platform roles are not seeded',
      });
    }

    const previousSlugs = currentRoles.map((r) => r.slug);

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(UserRole).delete({ user: { id: user.id } });
      await manager
        .getRepository(UserRole)
        .save(
          roleRows.map((role) =>
            manager
              .getRepository(UserRole)
              .create({ user: { id: user.id } as User, role }),
          ),
        );
    });

    // The permission set changed — existing sessions must not keep carrying
    // the old one (mirrors StaffAccessService.grant).
    await this.authService.revokeAllForUser(id);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.STAFF_ROLES_SET,
      userId: actorUserId,
      entityType: 'PlatformStaff',
      entityId: id,
      before: { roles: previousSlugs },
      after: { roles: roleRows.map((r) => r.slug) },
    });

    return this.summaryFor(id);
  }

  // ──────────────────────────────── Internals ─────────────────────────────── //

  /**
   * Loads a platform-scope target and refuses any row holding `super_admin`
   * — invariant #3: this surface must never mutate the platform operator.
   * A tenant user id is indistinguishable from a non-existent one (404) —
   * this method never leaks that a tenant user exists.
   */
  private async loadTarget(id: string): Promise<{ user: User; roles: Role[] }> {
    const user = await this.users.findOne({ where: { id, tenant: IsNull() } });
    if (!user) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Platform staff member not found',
      });
    }

    const links = await this.userRoles.find({
      where: { user: { id } },
      relations: { role: true },
    });
    const roles = links.map((l) => l.role).filter((r): r is Role => Boolean(r));

    if (roles.some((r) => r.slug === ROLE.SUPER_ADMIN)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'This management surface cannot modify a Super Admin account',
      });
    }

    return { user, roles };
  }

  private async primaryRoleSlug(userId: string): Promise<RoleSlug | undefined> {
    const link = await this.userRoles.findOne({
      where: { user: { id: userId } },
      relations: { role: true },
    });
    return link?.role?.slug as RoleSlug | undefined;
  }

  /** Issues a single-use set-password token and emails the invitation (best-effort). */
  private async sendInvitation(
    userId: string,
    email: string,
    fullName: string | undefined,
    roleSlug: RoleSlug | undefined,
    locale?: string | null,
  ): Promise<void> {
    const rawToken = await this.authService.issuePasswordSetupToken(userId);
    const roleName =
      ROLES.find((r) => r.slug === roleSlug)?.name ?? 'Platform Staff';

    try {
      await this.email.sendInvitation({
        to: email,
        name: fullName,
        role: roleName,
        invitationUrl: this.authService.passwordSetupUrl(rawToken),
        token: rawToken,
        locale: locale ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to deliver platform-staff invitation to user ${userId}: ${(err as Error)?.message}`,
      );
    }
  }

  private async decorate(users: User[]): Promise<PlatformStaffSummary[]> {
    if (users.length === 0) return [];
    const ids = users.map((u) => u.id);
    const emails = users
      .map((u) => u.email)
      .filter((e): e is string => Boolean(e));

    const [links, resets, latestInviteStatus] = await Promise.all([
      this.userRoles.find({
        where: { user: { id: In(ids) } },
        relations: { user: true, role: true },
      }),
      this.passwordResets.find({
        where: { user: { id: In(ids) } },
        relations: { user: true },
      }),
      this.emailDelivery.getLatestStatusByRecipient(
        emails,
        INVITATION_EMAIL_TEMPLATE,
      ),
    ]);

    const rolesByUser = new Map<string, string[]>();
    for (const link of links) {
      if (!link.user || !link.role) continue;
      const list = rolesByUser.get(link.user.id) ?? [];
      list.push(link.role.slug);
      rolesByUser.set(link.user.id, list);
    }

    const now = Date.now();
    const hasLiveInvite = new Set(
      resets
        .filter((r) => r.user && !r.used_at && r.expires_at.getTime() > now)
        .map((r) => r.user.id),
    );
    const everInvited = new Set(
      resets.filter((r) => r.user).map((r) => r.user.id),
    );

    return users.map((u) => {
      const roles = rolesByUser.get(u.id) ?? [];
      return {
        id: u.id,
        email: u.email ?? null,
        fullName: u.full_name ?? null,
        phone: u.phone ?? null,
        isActive: u.is_active,
        roles,
        lastLoginAt: u.last_login_at ?? null,
        invitationStatus: this.deriveStatus({
          roles,
          isActive: u.is_active,
          hasLoggedIn: Boolean(u.last_login_at),
          hasLiveInvite: hasLiveInvite.has(u.id),
          everInvited: everInvited.has(u.id),
          lastInviteFailed: u.email
            ? latestInviteStatus.get(u.email) === 'FAILED'
            : false,
        }),
        createdAt: u.created_at,
      };
    });
  }

  private deriveStatus(input: {
    roles: string[];
    isActive: boolean;
    hasLoggedIn: boolean;
    hasLiveInvite: boolean;
    everInvited: boolean;
    /** Latest recorded delivery attempt for this address ended in `email_logs.status = 'FAILED'`. */
    lastInviteFailed: boolean;
  }): PlatformStaffInvitationStatus {
    if (!input.roles.some((r) => isPlatformAssignableRole(r)))
      return 'no_access';
    if (!input.isActive) return 'disabled';
    if (input.hasLoggedIn) return 'active';
    // A confirmed provider-side failure is always shown as failed, even if a
    // still-live token exists — the admin needs to know a resend is actually
    // required, not that everything is fine and pending.
    if (input.lastInviteFailed) return 'invitation_failed';
    if (input.hasLiveInvite) return 'invitation_pending';
    return input.everInvited ? 'invitation_expired' : 'invitation_pending';
  }

  private async summaryFor(userId: string): Promise<PlatformStaffSummary> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Platform staff member not found',
      });
    }
    const [summary] = await this.decorate([user]);
    return summary;
  }
}
