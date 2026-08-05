import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { User } from '../../entities/Auth&RBAC/User';
import { Role } from '../../entities/Auth&RBAC/Role';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AppError, ErrorCode } from '../../common/errors';
import { ROLE } from '../../rbac/rbac.constants';
import { AuthService } from '../auth/auth.service';
import { RolesService } from '../auth/roles.service';
import { EmailService } from '../email/email.service';

/**
 * Lifecycle state of a staff member's Reception Dashboard login access.
 *
 * Derived — never stored. The two underlying facts already exist in the schema
 * (`user_roles` for the role, `users.is_active` for login access), so there is
 * no new status column and nothing that can drift out of sync.
 */
export type DashboardAccessStatus =
  | 'no_access'
  | 'invitation_pending'
  | 'invitation_expired'
  | 'active'
  | 'disabled';

export interface DashboardAccessState {
  status: DashboardAccessStatus;
  /** Role slugs currently held by the linked user account. */
  roles: string[];
  /** True when the account is not permitted to sign in at all. */
  isActive: boolean;
  lastLoginAt: Date | null;
}

/** Roles that must never be touched or replaced by this flow. */
const PROTECTED_ROLE_SLUGS: readonly string[] = [ROLE.SUPER_ADMIN, ROLE.OWNER];

/**
 * Grants / revokes Reception Dashboard access for an EXISTING staff member.
 *
 * ─── DOMAIN MODEL (verified against the schema, not assumed) ────────────────
 * `staff_profiles.user_id` is UNIQUE and every creation path
 * (`StaffService.create` links an existing user, `createWithNewUser`
 * provisions one) always populates it — the model is a strict 1:1
 * Staff↔User. There is therefore NO "staff member without a login account"
 * state, and this service never creates or links an account. Granting access
 * is purely a ROLE CHANGE on the already-linked user, plus the independent
 * `users.is_active` switch for enable/disable.
 *
 * ─── AUTHORIZATION ──────────────────────────────────────────────────────────
 * `tenantId` always comes from the authenticated principal (never the body).
 * Every lookup is tenant-scoped, so passing another clinic's staff id yields a
 * 404 rather than any cross-tenant effect (IDOR-safe). The receptionist role is
 * resolved server-side from {@link ROLE}; no role is ever read from the
 * request, so this endpoint cannot be used to mint an owner/manager/admin.
 */
@Injectable()
export class StaffAccessService {
  private readonly logger = new Logger(StaffAccessService.name);

  constructor(
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
    @InjectRepository(PasswordReset)
    private readonly passwordResets: Repository<PasswordReset>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly rolesService: RolesService,
    private readonly email: EmailService,
  ) {}

  // ──────────────────────────── Status derivation ────────────────────────── //

  /**
   * Bulk-resolves access state for many users in a fixed number of queries
   * (never one per row) so decorating a staff page stays O(1) in round-trips.
   */
  async getAccessStates(
    userIds: string[],
  ): Promise<Map<string, DashboardAccessState>> {
    const result = new Map<string, DashboardAccessState>();
    if (userIds.length === 0) return result;

    const [users, roleLinks, resets] = await Promise.all([
      this.users.find({ where: { id: In(userIds) } }),
      this.userRoles.find({
        where: { user: { id: In(userIds) } },
        relations: { user: true, role: true },
      }),
      // One pass over every invitation ever issued to these users — both
      // "is there a live one" and "was one ever sent" are derived in memory.
      this.passwordResets.find({
        where: { user: { id: In(userIds) } },
        relations: { user: true },
      }),
    ]);

    const rolesByUser = new Map<string, string[]>();
    for (const link of roleLinks) {
      if (!link.user || !link.role) continue;
      const list = rolesByUser.get(link.user.id) ?? [];
      list.push(link.role.slug);
      rolesByUser.set(link.user.id, list);
    }

    const now = Date.now();
    const hasLiveInvite = new Set(
      resets
        .filter(
          (r) => r.user && !r.used_at && r.expires_at.getTime() > now,
        )
        .map((r) => r.user.id),
    );
    const everInvited = new Set(
      resets.filter((r) => r.user).map((r) => r.user.id),
    );

    for (const user of users) {
      const roles = rolesByUser.get(user.id) ?? [];
      result.set(user.id, {
        roles,
        isActive: user.is_active,
        lastLoginAt: user.last_login_at ?? null,
        status: this.deriveStatus({
          roles,
          isActive: user.is_active,
          hasLoggedIn: Boolean(user.last_login_at),
          hasLiveInvite: hasLiveInvite.has(user.id),
          everInvited: everInvited.has(user.id),
        }),
      });
    }

    return result;
  }

  private deriveStatus(input: {
    roles: string[];
    isActive: boolean;
    hasLoggedIn: boolean;
    hasLiveInvite: boolean;
    everInvited: boolean;
  }): DashboardAccessStatus {
    // Access is defined by holding the receptionist role — nothing else.
    if (!input.roles.includes(ROLE.RECEPTIONIST)) return 'no_access';
    if (!input.isActive) return 'disabled';
    if (input.hasLoggedIn) return 'active';
    // Never signed in: distinguish "waiting on them" from "needs a resend".
    if (input.hasLiveInvite) return 'invitation_pending';
    return input.everInvited ? 'invitation_expired' : 'invitation_pending';
  }

  // ─────────────────────────────── Operations ────────────────────────────── //

  /**
   * Loads the staff member and their linked account, scoped to the caller's
   * clinic. A staff id from another tenant is indistinguishable from a
   * non-existent one (404) — that is the IDOR guarantee.
   */
  private async loadTarget(
    tenantId: string,
    staffId: string,
  ): Promise<{ profile: StaffProfile; user: User; roles: Role[] }> {
    const profile = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
      relations: { user: true },
    });
    if (!profile?.user) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }

    // Re-assert the ACCOUNT is in this clinic too — the staff row being in the
    // tenant is not on its own proof the linked user is.
    const user = await this.users.findOne({
      where: { id: profile.user.id, tenant: { id: tenantId } },
    });
    if (!user) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }

    const roles = await this.rolesService.listUserRoles(user.id, tenantId);
    return { profile, user, roles };
  }

  /** Refuses to touch founding/platform accounts (owner, super admin). */
  private assertNotProtected(roles: Role[]): void {
    const protectedRole = roles.find((r) =>
      PROTECTED_ROLE_SLUGS.includes(r.slug),
    );
    if (protectedRole) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Cannot change dashboard access for a "${protectedRole.slug}" account`,
      });
    }
  }

  /**
   * Grants Reception Dashboard access: REPLACES the linked account's tenant
   * role(s) with `receptionist`, re-enables login, invalidates existing
   * sessions (the permission set changed) and — if the person has never signed
   * in — emails a single-use set-password invitation.
   *
   * Idempotent: re-running for an already-active receptionist is a no-op that
   * neither re-revokes their sessions nor re-sends an invitation, so a
   * double-submitted request cannot sign the user out.
   */
  async grant(
    tenantId: string,
    staffId: string,
    actorUserId: string,
    ipAddress?: string,
  ): Promise<DashboardAccessState> {
    const { user, roles } = await this.loadTarget(tenantId, staffId);
    this.assertNotProtected(roles);

    const alreadyReception =
      roles.length === 1 && roles[0].slug === ROLE.RECEPTIONIST;
    if (alreadyReception && user.is_active) {
      // Nothing to change — return current state without side effects.
      return this.stateFor(user.id);
    }

    if (!user.email) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'This staff member has no email address, so they cannot be given dashboard access',
      });
    }

    // Resolved server-side from the RBAC catalogue — never from the request.
    const receptionRole = await this.rolesService.findAssignableRoleBySlug(
      ROLE.RECEPTIONIST,
      tenantId,
    );

    const previousRoles = roles.map((r) => r.slug);

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(UserRole).delete({ user: { id: user.id } });
      await manager.getRepository(UserRole).save(
        manager.getRepository(UserRole).create({
          user: { id: user.id } as User,
          role: { id: receptionRole.id } as Role,
        }),
      );
      await manager
        .getRepository(User)
        .update({ id: user.id }, { is_active: true });
    });

    // The permission set changed — existing access/refresh tokens must not
    // keep carrying the old one.
    await this.authService.revokeAllForUser(user.id);

    if (!user.last_login_at) {
      await this.sendInvitation(tenantId, user);
    }

    await this.audit({
      tenantId,
      actorUserId,
      action: 'staff.dashboard_access.granted',
      targetUserId: user.id,
      staffId,
      ipAddress,
      oldValues: { roles: previousRoles, is_active: user.is_active },
      newValues: { roles: [ROLE.RECEPTIONIST], is_active: true },
    });

    return this.stateFor(user.id);
  }

  /**
   * Enables or disables the account's ability to sign in. The StaffProfile —
   * and every appointment, note and record the person created — is untouched;
   * only `users.is_active` flips. Disabling also revokes refresh tokens so
   * live sessions die immediately rather than lingering until expiry.
   */
  async setEnabled(
    tenantId: string,
    staffId: string,
    enabled: boolean,
    actorUserId: string,
    ipAddress?: string,
  ): Promise<DashboardAccessState> {
    const { user, roles } = await this.loadTarget(tenantId, staffId);
    this.assertNotProtected(roles);

    if (!roles.some((r) => r.slug === ROLE.RECEPTIONIST)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This staff member does not have dashboard access yet',
      });
    }

    if (user.is_active === enabled) return this.stateFor(user.id); // idempotent

    await this.users.update({ id: user.id }, { is_active: enabled });
    if (!enabled) await this.authService.revokeAllForUser(user.id);

    await this.audit({
      tenantId,
      actorUserId,
      action: enabled
        ? 'staff.dashboard_access.enabled'
        : 'staff.dashboard_access.disabled',
      targetUserId: user.id,
      staffId,
      ipAddress,
      oldValues: { is_active: user.is_active },
      newValues: { is_active: enabled },
    });

    return this.stateFor(user.id);
  }

  /**
   * Re-issues the set-password invitation. Only meaningful while the person
   * has never signed in — once they have, they own their password and should
   * use the normal forgot-password flow instead.
   */
  async resendInvitation(
    tenantId: string,
    staffId: string,
    actorUserId: string,
    ipAddress?: string,
  ): Promise<DashboardAccessState> {
    const { user, roles } = await this.loadTarget(tenantId, staffId);
    this.assertNotProtected(roles);

    if (!roles.some((r) => r.slug === ROLE.RECEPTIONIST)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This staff member does not have dashboard access yet',
      });
    }
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

    await this.sendInvitation(tenantId, user);

    await this.audit({
      tenantId,
      actorUserId,
      action: 'staff.dashboard_access.invitation_resent',
      targetUserId: user.id,
      staffId,
      ipAddress,
    });

    return this.stateFor(user.id);
  }

  // ──────────────────────────────── internals ────────────────────────────── //

  /**
   * Issues a single-use set-password token and emails the invitation. The raw
   * token lives only in the email — it is stored hashed and never logged.
   * Delivery is best-effort: a mail outage must not roll back an access grant
   * that already succeeded (the owner can resend).
   */
  private async sendInvitation(tenantId: string, user: User): Promise<void> {
    const rawToken = await this.authService.issuePasswordSetupToken(user.id);

    try {
      await this.email.sendInvitation({
        to: user.email as string,
        name: user.full_name ?? undefined,
        role: 'Receptionist',
        invitationUrl: this.authService.passwordSetupUrl(rawToken),
        tenantId,
        token: rawToken,
        // M-08 — NULL (no preference recorded yet, the common case for a
        // brand-new invitee) falls back to DEFAULT_LOCALE/EMAIL_DEFAULT_LOCALE
        // exactly as before this change; nothing regresses.
        locale: user.preferred_locale,
      });
    } catch (err) {
      // Never include the token or any credential in the log line.
      this.logger.warn(
        `Failed to deliver dashboard-access invitation to user ${user.id}: ${
          (err as Error)?.message
        }`,
      );
    }
  }

  private async stateFor(userId: string): Promise<DashboardAccessState> {
    const states = await this.getAccessStates([userId]);
    const state = states.get(userId);
    if (!state) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Account not found' });
    }
    return state;
  }

  /**
   * Writes an audit row. Deliberately records only identifiers and role/flag
   * changes — never tokens, passwords or session material.
   */
  private async audit(entry: {
    tenantId: string;
    actorUserId: string;
    action: string;
    targetUserId: string;
    staffId: string;
    ipAddress?: string;
    oldValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
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
            ...(entry.oldValues ?? {}),
            target_user_id: entry.targetUserId,
          },
          new_values: entry.newValues,
          ip_address: entry.ipAddress,
        }),
      );
    } catch (err) {
      // Auditing must never break the operation it is recording.
      this.logger.warn(
        `Failed to write audit log for ${entry.action}: ${(err as Error)?.message}`,
      );
    }
  }
}
