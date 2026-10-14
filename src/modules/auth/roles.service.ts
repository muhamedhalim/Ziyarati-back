import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { EntityManager, In, IsNull, Repository } from 'typeorm';

import { Role } from '../../entities/Auth&RBAC/Role';
import { Permission } from '../../entities/Auth&RBAC/Permission';
import { RolePermission } from '../../entities/Auth&RBAC/RolePermission';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AppError, ErrorCode } from '../../common/errors';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { LOG_EVENT } from '../../common/logging/log-events';
import {
  CUSTOM_ROLE_NAME_FALLBACK,
  CUSTOM_ROLE_NAME_PREFIX,
  CUSTOM_ROLE_SENTINEL,
  NON_STAFF_ROLE_SLUGS,
  PERMISSION,
  PermissionSlug,
  RESERVED_PERMISSION_SLUGS,
  ROLE,
  RoleSlug,
  UNENFORCED_PERMISSION_SLUGS,
} from '../../rbac/rbac.constants';

/**
 * Privileged roles that must NEVER be grantable through the roles API.
 *
 * - `super_admin`: platform role, seeded only. Granting it would escalate a
 *   tenant user to full platform control (PermissionsGuard bypasses on this
 *   slug).
 * - `owner`: a tenant's founding role, created exclusively via
 *   `/auth/register-owner`.
 * - `platform_support`: platform role, provisioned exclusively via
 *   `/platform/staff`. Without this block, `assignRoleToUser` (which admits
 *   any `is_system` role regardless of the caller's tenant — see `findOne`)
 *   would let a clinic Owner holding `roles.manage` grant a
 *   `platform_support`-carrying role to their own tenant staff, a
 *   cross-boundary escalation. Defence in depth alongside
 *   `RESERVED_PERMISSION_SLUGS` (rbac.constants.ts), which additionally
 *   blocks the underlying permission slugs from a synthesized custom role.
 *
 * This is the hard boundary between the Platform layer and the Tenant layer.
 */
const API_PROTECTED_ROLE_SLUGS: readonly string[] = [
  ROLE.SUPER_ADMIN,
  ROLE.OWNER,
  ROLE.PLATFORM_SUPPORT,
  ROLE.PLATFORM_SALES,
];

/**
 * Manages roles and role/permission/user assignments. Every operation is
 * scoped to the caller's tenant (`tenantId === null` means platform
 * super-admin, who owns the system roles whose tenant is also null).
 */
@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(RolePermission)
    private readonly rolePermissions: Repository<RolePermission>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(
    dto: CreateRoleDto,
    tenantId: string | null,
    callerPermissions: string[] = [],
  ): Promise<Role> {
    if (dto.slug === CUSTOM_ROLE_SENTINEL) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Slug "${CUSTOM_ROLE_SENTINEL}" is reserved and cannot be used for a role`,
      });
    }

    const duplicate = await this.roles.findOne({
      where: {
        slug: dto.slug,
        tenant: tenantId ? { id: tenantId } : IsNull(),
      },
    });
    if (duplicate) {
      throw new AppError(ErrorCode.ROLE_ALREADY_EXISTS);
    }

    // FND-009 — validated BEFORE any row is written, so a refused request
    // creates nothing at all (mirrors validateCustomPermissions' own
    // "fail fast before any transaction opens" rule).
    if (dto.permissionSlugs?.length) {
      await this.assertMutationPermissionsAllowed(
        dto.permissionSlugs,
        callerPermissions,
        tenantId,
        undefined,
        'create',
      );
    }

    const role = this.roles.create({
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      is_system: false,
      tenant: tenantId ? ({ id: tenantId } as Role['tenant']) : undefined,
    });
    const saved = await this.roles.save(role);

    if (dto.permissionSlugs?.length) {
      const perms = await this.permissions.find({
        where: { slug: In(dto.permissionSlugs) },
      });
      await this.rolePermissions.save(
        perms.map((permission) =>
          this.rolePermissions.create({ role: saved, permission }),
        ),
      );
    }
    return this.findOne(saved.id, tenantId);
  }

  /** Lists the tenant's own roles plus globally-shared system roles. */
  findAll(tenantId: string | null): Promise<Role[]> {
    return this.roles.find({
      where: [
        { tenant: tenantId ? { id: tenantId } : IsNull() },
        { is_system: true },
      ],
      relations: { rolePermissions: { permission: true } },
      order: { name: 'ASC' },
    });
  }

  /**
   * The role a tenant OWNS under exactly this slug, or `null`. The same
   * `(slug, tenant)` key `create()` uses for its duplicate check, so a lookup
   * that finds nothing here is precisely a lookup after which `create()` will
   * succeed. System roles (tenant-less) are deliberately not matched.
   *
   * Exists because `findAll()` does not load the `tenant` relation: a caller
   * that filters its result on `role.tenant?.id` can never match, then hits
   * `ROLE_ALREADY_EXISTS` on the create that follows (F-25).
   */
  findTenantRoleBySlug(tenantId: string, slug: string): Promise<Role | null> {
    return this.roles.findOne({
      where: { slug, tenant: { id: tenantId } },
    });
  }

  async findOne(id: string, tenantId: string | null): Promise<Role> {
    const role = await this.roles.findOne({
      where: { id },
      relations: { tenant: true, rolePermissions: { permission: true } },
    });
    if (!role) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND);
    }
    // Visible if it belongs to the tenant or is a shared system role.
    const ownedByTenant = (role.tenant?.id ?? null) === tenantId;
    if (!ownedByTenant && !role.is_system) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND);
    }
    return role;
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
    tenantId: string | null,
    callerPermissions: string[] = [],
  ): Promise<Role> {
    const role = await this.assertMutable(id, tenantId);

    // FND-009 — a role that ALREADY holds a reserved permission is detected
    // on mutation attempt and refused outright (never silently altered),
    // even for a metadata-only change. Exempt on the platform path, where
    // legitimately-reserved global roles (owner/super_admin) live.
    await this.assertNoStoredReservedPermission(role, tenantId, 'update');

    if (dto.permissionSlugs) {
      await this.assertMutationPermissionsAllowed(
        dto.permissionSlugs,
        callerPermissions,
        tenantId,
        id,
        'update',
      );
    }

    Object.assign(role, {
      name: dto.name ?? role.name,
      description: dto.description ?? role.description,
    });
    await this.roles.save(role);

    if (dto.permissionSlugs) {
      const perms = dto.permissionSlugs.length
        ? await this.permissions.find({
            where: { slug: In(dto.permissionSlugs) },
          })
        : [];
      await this.replaceRolePermissions(
        role,
        perms.map((p) => p.id),
      );
    }
    return this.findOne(id, tenantId);
  }

  async remove(id: string, tenantId: string | null): Promise<void> {
    const role = await this.assertMutable(id, tenantId);
    await this.roles.softRemove(role);
  }

  /** Replaces the role's full permission set with the given permission ids. */
  async setPermissions(
    roleId: string,
    permissionIds: string[],
    tenantId: string | null,
    callerPermissions: string[] = [],
  ): Promise<Role> {
    const role = await this.assertMutable(roleId, tenantId);
    await this.assertNoStoredReservedPermission(role, tenantId, 'setPermissions');

    let found: Permission[] = [];
    if (permissionIds.length) {
      found = await this.permissions.find({
        where: { id: In(permissionIds) },
      });
      if (found.length !== permissionIds.length) {
        throw new AppError(ErrorCode.PERMISSION_NOT_FOUND, { message: 'One or more permissions do not exist' });
      }
    }

    // FND-009 — the DTO carries permission UUIDs, not slugs; derive slugs
    // from the rows ALREADY loaded above to verify existence, so this adds
    // no extra query (PR-008).
    await this.assertMutationPermissionsAllowed(
      found.map((p) => p.slug),
      callerPermissions,
      tenantId,
      roleId,
      'setPermissions',
    );

    await this.replaceRolePermissions(role, permissionIds);
    this.logRoleChange('permissions_replaced', { role_id: roleId, tenant_id: tenantId ?? undefined, permission_count: permissionIds.length });
    return this.findOne(roleId, tenantId);
  }

  // ------------------------ staff assignability --------------------------- //

  /**
   * Roles a tenant may assign to a STAFF member: the tenant's own custom
   * roles plus system roles, minus {@link NON_STAFF_ROLE_SLUGS}. Backs the Add
   * Staff Member role selector — reuses the exact same tenant/system role
   * query as {@link findAll}, so a tenant's custom roles show up with no code
   * change, while founding/platform/non-staff roles never do.
   */
  async findAssignableForStaff(tenantId: string): Promise<Role[]> {
    const roles = await this.findAll(tenantId);
    return roles.filter(
      (r) => !NON_STAFF_ROLE_SLUGS.includes(r.slug as RoleSlug),
    );
  }

  /**
   * Resolves + validates a role slug for STAFF assignment: must exist as
   * either one of the tenant's own custom roles or a shared system role, and
   * must not be one of {@link NON_STAFF_ROLE_SLUGS}. Throws otherwise — this
   * is the backend enforcement mirror of {@link findAssignableForStaff}, so a
   * forced/direct API call can't smuggle in a role the selector never offered.
   */
  async findAssignableRoleBySlug(
    slug: string,
    tenantId: string,
  ): Promise<Role> {
    if (NON_STAFF_ROLE_SLUGS.includes(slug as RoleSlug)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Role "${slug}" cannot be assigned to staff`,
      });
    }
    const role = await this.roles.findOne({
      where: [
        { slug, tenant: { id: tenantId } },
        { slug, tenant: IsNull(), is_system: true },
      ],
    });
    if (!role) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND, {
        message: `Role "${slug}" not found`,
      });
    }
    return role;
  }

  /**
   * The FULL permission set granted by a role assignable to staff — same
   * visibility + {@link NON_STAFF_ROLE_SLUGS} guard as
   * {@link findAssignableForStaff}, so this can only ever return permissions
   * for a role the Add/Edit Staff role selector itself offered. Unlike
   * {@link findGrantableForCaller}, this is NEVER filtered to what the caller
   * holds — it backs a read-only PREVIEW of what a predefined role
   * (Doctor/Manager/Receptionist/a tenant custom role) actually grants,
   * shown before the staff member is created. Purely informational: it does
   * not change what gets granted on submit (see StaffService.createWithNewUser,
   * which re-resolves the role's permissions server-side regardless).
   */
  async findAssignableRolePermissions(
    roleId: string,
    tenantId: string,
  ): Promise<Permission[]> {
    const role = await this.findOne(roleId, tenantId); // enforces visibility
    if (NON_STAFF_ROLE_SLUGS.includes(role.slug as RoleSlug)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Role "${role.slug}" cannot be assigned to staff`,
      });
    }
    return role.rolePermissions
      .map((rp) => rp.permission)
      .sort(
        (a, b) =>
          (a.module ?? '').localeCompare(b.module ?? '') ||
          a.name.localeCompare(b.name),
      );
  }

  /**
   * The permission catalogue entries the CALLER may grant to someone else —
   * always a subset of the caller's own `permissions` (never the full
   * catalogue), and never {@link RESERVED_PERMISSION_SLUGS} or
   * `dashboard.access` (auto-granted to every custom role — see
   * {@link resolveCustomRole} — so it is never a meaningful checklist item).
   * Backs the "Other" role permissions selector: a Manager who lacks
   * `payments.manage` can never see it as a choice, let alone submit it, so
   * there is no way to escalate through this endpoint. Order is stable
   * (module, then name) for a predictable grouped UI.
   */
  async findGrantableForCaller(callerPermissions: string[]): Promise<Permission[]> {
    const selectable = callerPermissions.filter(
      (p) =>
        p !== PERMISSION.DASHBOARD_ACCESS &&
        !RESERVED_PERMISSION_SLUGS.has(p as PermissionSlug),
    );
    if (!selectable.length) return [];
    return this.permissions.find({
      where: { slug: In(selectable) },
      order: { module: 'ASC', name: 'ASC' },
    });
  }

  /**
   * Validates a requested custom-permission set WITHOUT writing anything —
   * pure reads/checks, so a doomed request fails fast BEFORE any transaction
   * opens (see StaffService.createWithNewUser/changeRole, which call this
   * first, then {@link resolveCustomRole} inside their transaction only once
   * validation has passed).
   *
   * Rejects, in order: an empty selection; a slug in
   * {@link RESERVED_PERMISSION_SLUGS} (never delegatable through this flow,
   * regardless of the caller's own holdings — closes the self-escalation
   * path where a custom-role employee granted `roles.manage`/`users.manage`
   * could bypass every other guard here via the standalone Roles/Users API);
   * an unknown slug; and finally any slug the caller does not themselves
   * hold (the base privilege-escalation guard).
   */
  async validateCustomPermissions(
    permissionSlugs: string[] | undefined,
    callerPermissions: string[],
  ): Promise<Permission[]> {
    const slugs = Array.from(new Set(permissionSlugs ?? []));
    if (slugs.length === 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Select at least one permission for a custom role',
      });
    }

    const reserved = slugs.filter((s) => RESERVED_PERMISSION_SLUGS.has(s as PermissionSlug));
    if (reserved.length) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `These permissions can never be granted to a custom role: ${reserved.join(', ')}`,
      });
    }

    const perms = await this.permissions.find({ where: { slug: In(slugs) } });
    if (perms.length !== slugs.length) {
      throw new AppError(ErrorCode.PERMISSION_NOT_FOUND, {
        message: 'One or more permissions do not exist',
      });
    }

    const callerSet = new Set(callerPermissions);
    const notHeld = slugs.filter((s) => !callerSet.has(s));
    if (notHeld.length) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `You cannot grant a permission you do not hold: ${notHeld.join(', ')}`,
      });
    }

    return perms;
  }

  /**
   * Resolves the role backing the "Other" option: a tenant-scoped custom
   * role carrying `perms` PLUS the implicit `dashboard.access` (every
   * custom-role employee needs it to reach the workspace at all — see
   * PERMISSION.DASHBOARD_ACCESS). No new authorization mechanism — this is
   * the same `roles` / `role_permissions` / `user_roles` machinery every
   * other role uses (mirrors how the AI Bot Actor's role is lazily created
   * per tenant, see {@link ROLE.AI_BOT} in rbac.constants.ts).
   *
   * ALWAYS runs inside the CALLER's transaction (`manager`) — never opens its
   * own — so the role/role_permissions writes here are atomic with the
   * surrounding user/staff/user_roles writes (see StaffService).
   *
   * Per-employee ownership (never affects another employee): when
   * `existingUserId` is given and that user's SOLE current role is already a
   * tenant custom role held ONLY by them, its permission set is replaced IN
   * PLACE (repeated edits update that one employee's role and nothing else,
   * and don't pile up orphaned roles). Otherwise a fresh custom role is
   * created — this NEVER mutates a role another user might also hold, and
   * two employees who happen to be given the identical permission set still
   * get two distinct roles (no reuse across employees, ever).
   */
  async resolveCustomRole(
    tenantId: string,
    perms: Permission[],
    existingUserId: string | null,
    displayNameHint: string | undefined,
    manager: EntityManager,
  ): Promise<Role> {
    const roleRepo = manager.getRepository(Role);
    const permissionRepo = manager.getRepository(Permission);
    const rolePermissionRepo = manager.getRepository(RolePermission);

    const dashboardAccess = await permissionRepo.findOne({
      where: { slug: PERMISSION.DASHBOARD_ACCESS },
    });
    const grantedPerms =
      dashboardAccess && !perms.some((p) => p.id === dashboardAccess.id)
        ? [...perms, dashboardAccess]
        : perms;

    if (existingUserId) {
      const reusable = await this.findSoleCustomRole(existingUserId, tenantId, manager);
      if (reusable) {
        await rolePermissionRepo.delete({ role: { id: reusable.id } });
        await rolePermissionRepo.save(
          grantedPerms.map((permission) =>
            rolePermissionRepo.create({ role: reusable, permission }),
          ),
        );
        return reusable;
      }
    }

    const role = roleRepo.create({
      name: displayNameHint
        ? `${CUSTOM_ROLE_NAME_PREFIX}${displayNameHint}`
        : CUSTOM_ROLE_NAME_FALLBACK,
      slug: `custom-${randomUUID()}`,
      is_system: false,
      tenant: { id: tenantId } as Role['tenant'],
    });
    const saved = await roleRepo.save(role);
    await rolePermissionRepo.save(
      grantedPerms.map((permission) => rolePermissionRepo.create({ role: saved, permission })),
    );
    return saved;
  }

  /**
   * The user's current custom (non-system) tenant role, ONLY when it is
   * their sole role AND no other user also holds it — otherwise `null`, so
   * the caller creates a fresh role instead of mutating one someone else
   * might depend on. A custom role must belong to exactly one employee.
   */
  private async findSoleCustomRole(
    userId: string,
    tenantId: string,
    manager: EntityManager,
  ): Promise<Role | null> {
    const userRoleRepo = manager.getRepository(UserRole);
    const links = await userRoleRepo.find({
      where: { user: { id: userId } },
      relations: { role: { tenant: true } },
    });
    if (links.length !== 1) return null;

    const role = links[0].role;
    if (role.is_system || (role.tenant?.id ?? null) !== tenantId) return null;

    const holders = await userRoleRepo.count({ where: { role: { id: role.id } } });
    return holders === 1 ? role : null;
  }

  /**
   * When an employee moves OFF a role (e.g. from the synthesized "Other"
   * role onto a catalogue role like Doctor), the old role may now have zero
   * holders. If it is a tenant custom (non-system) role, delete it — never a
   * system role, which is shared platform-wide and must never be touched
   * here. Runs inside the caller's transaction so the cleanup is atomic with
   * the reassignment that orphaned it.
   */
  async deleteIfOrphanedCustomRole(role: Role, manager: EntityManager): Promise<void> {
    if (role.is_system) return;
    const remaining = await manager
      .getRepository(UserRole)
      .count({ where: { role: { id: role.id } } });
    if (remaining === 0) {
      await manager.getRepository(Role).softRemove(role);
    }
  }

  // --------------------------- user assignments -------------------------- //

  async assignRoleToUser(
    userId: string,
    roleId: string,
    tenantId: string | null,
  ): Promise<UserRole> {
    const user = await this.assertUserInTenant(userId, tenantId);
    const role = await this.findOne(roleId, tenantId); // enforces visibility, loads rolePermissions.permission
    this.assertRoleAssignableViaApi(role); // blocks super_admin / owner

    // FND-009 — defence in depth: assignment must not be a bypass of the
    // create/update/setPermissions restriction. In practice already covered
    // for every role that actually exists (API_PROTECTED_ROLE_SLUGS blocks
    // the only two roles that hold a reserved permission today), but this
    // closes the path for a hypothetical tenant-scoped role that somehow
    // carries one. Zero extra queries — `findOne` above already loaded
    // `rolePermissions.permission`.
    await this.assertNoStoredReservedPermission(role, tenantId, 'assign');
    await this.assertNoUnenforcedPermission(role);

    const existing = await this.userRoles.findOne({
      where: { user: { id: user.id }, role: { id: role.id } },
    });
    if (existing) {
      throw new AppError(ErrorCode.ROLE_ASSIGNMENT_EXISTS);
    }
    const saved = await this.userRoles.save(this.userRoles.create({ user, role }));
    this.logRoleChange('role_assigned', { role_id: role.id, target_user_id: user.id, tenant_id: tenantId ?? undefined });
    return saved;
  }

  async removeRoleFromUser(
    userId: string,
    roleId: string,
    tenantId: string | null,
  ): Promise<void> {
    await this.assertUserInTenant(userId, tenantId);
    const link = await this.userRoles.findOne({
      where: { user: { id: userId }, role: { id: roleId } },
    });
    if (!link) {
      throw new AppError(ErrorCode.ROLE_ASSIGNMENT_NOT_FOUND);
    }
    await this.userRoles.remove(link);
    this.logRoleChange('role_unassigned', { role_id: roleId, target_user_id: userId, tenant_id: tenantId ?? undefined });
  }

  /**
   * Operational breadcrumb for a COMMITTED role/permission change (LOGGING.md).
   * The acting user and request id come from the log context automatically;
   * only ids and counts are logged, never permission slugs or names.
   */
  private logRoleChange(action: string, fields: Record<string, unknown>): void {
    this.logger.log({
      event: LOG_EVENT.AUTH_ROLE_PERMISSIONS_CHANGED,
      message: `Role change: ${action}`,
      action,
      ...fields,
    });
  }

  async listUserRoles(
    userId: string,
    tenantId: string | null,
  ): Promise<Role[]> {
    await this.assertUserInTenant(userId, tenantId);
    const links = await this.userRoles.find({
      where: { user: { id: userId } },
      relations: { role: true },
    });
    return links.map((l) => l.role);
  }

  // ------------------------------ internals ------------------------------ //

  /**
   * Blocks granting platform/founding roles via the API. `super_admin` is
   * created only by the seeder; `owner` only via `/auth/register-owner`.
   */
  private assertRoleAssignableViaApi(role: Role): void {
    if (API_PROTECTED_ROLE_SLUGS.includes(role.slug)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Role "${role.slug}" cannot be assigned through the API`,
      });
    }
  }

  /**
   * Loads a role and asserts the caller's tenant is allowed to mutate it.
   * Also loads `rolePermissions.permission` (FND-009) so
   * {@link assertNoStoredReservedPermission} can check the role's CURRENT
   * stored permissions with no extra query — `update` and `setPermissions`
   * both call this before touching anything else.
   */
  private async assertMutable(
    id: string,
    tenantId: string | null,
  ): Promise<Role> {
    const role = await this.roles.findOne({
      where: { id },
      relations: { tenant: true, rolePermissions: { permission: true } },
    });
    if (!role) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND);
    }
    // A tenant can only mutate roles it owns. System roles (tenant null) are
    // mutable only by the super-admin (tenantId null) — handled by equality.
    //
    // FND-009 note: this equality check is ALSO what makes the platform
    // exemption below reduce to a single `tenantId === null` test — a role
    // can only reach that point once its tenant scope already equals the
    // caller's, so "global role AND platform caller" and "platform caller"
    // are equivalent here by construction.
    if ((role.tenant?.id ?? null) !== tenantId) {
      throw new AppError(ErrorCode.ROLE_IMMUTABLE, { message: 'You cannot modify this role' });
    }
    if (role.is_system && tenantId !== null) {
      throw new AppError(ErrorCode.ROLE_IMMUTABLE, { message: 'System roles cannot be modified' });
    }
    return role;
  }

  /**
   * FND-009 — the reserved-slug + caller-must-hold guard shared by
   * `create`/`update`/`setPermissions`. Deliberately SEPARATE from
   * {@link validateCustomPermissions} (the staff "Other"-role flow), whose
   * reject-empty-selection rule would wrongly break `update`'s documented
   * "omit the field to leave permissions unchanged / send `[]` to clear
   * everything" contract (`SetRolePermissionsDto`).
   *
   * Exemption: skipped ENTIRELY when `tenantId === null` — the platform
   * path, which legitimately manages global system roles
   * (`owner`/`super_admin`) that hold reserved permissions. Because
   * {@link assertMutable} already guarantees the target role's tenant scope
   * equals the caller's, this single check is equivalent to "the target
   * role is global AND the caller is platform-scoped" — never decided from
   * role-name membership, and never from a client-supplied value.
   */
  private async assertMutationPermissionsAllowed(
    slugs: string[],
    callerPermissions: string[],
    tenantId: string | null,
    roleId: string | undefined,
    operation: 'create' | 'update' | 'setPermissions',
  ): Promise<void> {
    if (slugs.length === 0) return; // explicit empty selection — clear-all, always allowed
    if (tenantId === null) return; // platform path — exempt

    const reserved = slugs.filter((s) => RESERVED_PERMISSION_SLUGS.has(s as PermissionSlug));
    if (reserved.length) {
      await this.auditRejectedMutation(roleId, reserved, operation);
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `These permissions can never be granted to a tenant role: ${reserved.join(', ')}`,
      });
    }

    const callerSet = new Set(callerPermissions);
    const notHeld = slugs.filter((s) => !callerSet.has(s));
    if (notHeld.length) {
      await this.auditRejectedMutation(roleId, notHeld, operation);
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `You cannot grant a permission you do not hold: ${notHeld.join(', ')}`,
      });
    }
  }

  /**
   * FND-009 — a role that ALREADY holds a reserved permission (measured
   * population today: zero) is detected on mutation attempt only — no
   * startup sweep, no reporting endpoint — and the mutation is refused
   * outright, so a stored violation is never silently altered. Reads and
   * existing grants are unaffected; only mutation is gated. Exempt on the
   * platform path for the same reason as the sibling check above.
   */
  private async assertNoStoredReservedPermission(
    role: Role,
    tenantId: string | null,
    operation: 'update' | 'setPermissions' | 'assign',
  ): Promise<void> {
    if (tenantId === null) return; // platform path — exempt

    const offending = Array.from(
      new Set(
        (role.rolePermissions ?? [])
          .map((rp) => rp.permission?.slug)
          .filter((slug): slug is PermissionSlug =>
            RESERVED_PERMISSION_SLUGS.has(slug as PermissionSlug),
          ),
      ),
    );
    if (offending.length) {
      await this.auditRejectedMutation(role.id, offending, operation);
      throw new AppError(ErrorCode.FORBIDDEN, {
        message:
          'This role already holds a reserved permission and cannot be mutated. Contact a platform administrator.',
      });
    }
  }

  /**
   * FND-010 — refuses to let a role carrying a permission with no verified
   * enforcing consumer (`UNENFORCED_PERMISSION_SLUGS`) become assignable to a
   * user. Converts a latent gap into a structurally impossible state: today
   * only `profile.update_own` (held by `ROLE.CUSTOMER`) qualifies, and no
   * code path currently assigns `customer` to anyone — this guard is what
   * keeps that true once something eventually tries. Unlike
   * {@link assertNoStoredReservedPermission}, this runs for EVERY caller
   * including the platform path (no `tenantId === null` exemption) — an
   * unenforced permission is unenforced regardless of who assigns the role.
   */
  private async assertNoUnenforcedPermission(role: Role): Promise<void> {
    const offending = Array.from(
      new Set(
        (role.rolePermissions ?? [])
          .map((rp) => rp.permission?.slug)
          .filter((slug): slug is PermissionSlug =>
            UNENFORCED_PERMISSION_SLUGS.has(slug as PermissionSlug),
          ),
      ),
    );
    if (offending.length) {
      await this.auditRejectedMutation(role.id, offending, 'assign');
      throw new AppError(ErrorCode.FORBIDDEN, {
        message:
          'This role carries a permission with no enforced authorization path and cannot be assigned.',
      });
    }
  }

  /**
   * Safe audit record (OB-003, OB-005, OB-006) mirroring Feature 002's
   * `WhatsappDlqService.audit` helper: identifiers and outcome only, never a
   * credential or request body. Wrapped so a write failure logs a warning
   * and never masks or blocks the security decision it records.
   */
  private async auditRejectedMutation(
    roleId: string | undefined,
    rejectedSlugs: string[],
    operation: string,
  ): Promise<void> {
    try {
      const tenantId = this.tenantContext.getTenantId();
      const userId = this.tenantContext.getUser()?.id;
      await this.auditLogs.save(
        this.auditLogs.create({
          tenant: tenantId ? ({ id: tenantId } as Tenant) : undefined,
          user: userId ? ({ id: userId } as User) : undefined,
          action: 'rbac.role.permissions_rejected',
          entity_type: 'role',
          entity_id: roleId,
          new_values: {
            result: 'rejected',
            rejectedSlugs,
            operation,
            correlationId: this.tenantContext.getCorrelationId() ?? null,
          },
        }),
      );
    } catch (err) {
      this.logger.warn(`Role mutation audit write failed: ${(err as Error).message}`);
    }
  }

  private async assertUserInTenant(
    userId: string,
    tenantId: string | null,
  ): Promise<User> {
    const user = await this.users.findOne({
      where: { id: userId },
      relations: { tenant: true },
    });
    if (!user || (user.tenant?.id ?? null) !== tenantId) {
      throw new AppError(ErrorCode.USER_NOT_FOUND);
    }
    return user;
  }

  private async replaceRolePermissions(
    role: Role,
    permissionIds: string[],
  ): Promise<void> {
    await this.rolePermissions.delete({ role: { id: role.id } });
    if (permissionIds.length) {
      await this.rolePermissions.save(
        permissionIds.map((id) =>
          this.rolePermissions.create({
            role,
            permission: { id } as Permission,
          }),
        ),
      );
    }
  }
}
