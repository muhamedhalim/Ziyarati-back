import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { Role } from '../../entities/Auth&RBAC/Role';
import { Permission } from '../../entities/Auth&RBAC/Permission';
import { RolePermission } from '../../entities/Auth&RBAC/RolePermission';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';

import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AppError, ErrorCode } from '../../common/errors';
import { NON_STAFF_ROLE_SLUGS, ROLE, RoleSlug } from '../../rbac/rbac.constants';

/**
 * Privileged roles that must NEVER be grantable through the roles API.
 *
 * - `super_admin`: platform role, seeded only. Granting it would escalate a
 *   tenant user to full platform control (PermissionsGuard bypasses on this
 *   slug).
 * - `owner`: a tenant's founding role, created exclusively via
 *   `/auth/register-owner`.
 *
 * This is the hard boundary between the Platform layer and the Tenant layer.
 */
const API_PROTECTED_ROLE_SLUGS: readonly string[] = [
  ROLE.SUPER_ADMIN,
  ROLE.OWNER,
];

/**
 * Manages roles and role/permission/user assignments. Every operation is
 * scoped to the caller's tenant (`tenantId === null` means platform
 * super-admin, who owns the system roles whose tenant is also null).
 */
@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(RolePermission)
    private readonly rolePermissions: Repository<RolePermission>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
  ) {}

  async create(dto: CreateRoleDto, tenantId: string | null): Promise<Role> {
    const duplicate = await this.roles.findOne({
      where: {
        slug: dto.slug,
        tenant: tenantId ? { id: tenantId } : IsNull(),
      },
    });
    if (duplicate) {
      throw new AppError(ErrorCode.ROLE_ALREADY_EXISTS);
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
  ): Promise<Role> {
    const role = await this.assertMutable(id, tenantId);
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
  ): Promise<Role> {
    const role = await this.assertMutable(roleId, tenantId);

    if (permissionIds.length) {
      const found = await this.permissions.find({
        where: { id: In(permissionIds) },
      });
      if (found.length !== permissionIds.length) {
        throw new AppError(ErrorCode.PERMISSION_NOT_FOUND, { message: 'One or more permissions do not exist' });
      }
    }
    await this.replaceRolePermissions(role, permissionIds);
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

  // --------------------------- user assignments -------------------------- //

  async assignRoleToUser(
    userId: string,
    roleId: string,
    tenantId: string | null,
  ): Promise<UserRole> {
    const user = await this.assertUserInTenant(userId, tenantId);
    const role = await this.findOne(roleId, tenantId); // enforces visibility
    this.assertRoleAssignableViaApi(role); // blocks super_admin / owner

    const existing = await this.userRoles.findOne({
      where: { user: { id: user.id }, role: { id: role.id } },
    });
    if (existing) {
      throw new AppError(ErrorCode.ROLE_ASSIGNMENT_EXISTS);
    }
    return this.userRoles.save(this.userRoles.create({ user, role }));
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

  /** Loads a role and asserts the caller's tenant is allowed to mutate it. */
  private async assertMutable(
    id: string,
    tenantId: string | null,
  ): Promise<Role> {
    const role = await this.roles.findOne({
      where: { id },
      relations: { tenant: true },
    });
    if (!role) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND);
    }
    // A tenant can only mutate roles it owns. System roles (tenant null) are
    // mutable only by the super-admin (tenantId null) — handled by equality.
    if ((role.tenant?.id ?? null) !== tenantId) {
      throw new AppError(ErrorCode.ROLE_IMMUTABLE, { message: 'You cannot modify this role' });
    }
    if (role.is_system && tenantId !== null) {
      throw new AppError(ErrorCode.ROLE_IMMUTABLE, { message: 'System roles cannot be modified' });
    }
    return role;
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
