import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { Role } from '../../entities/Auth&RBAC/Role';
import { Permission } from '../../entities/Auth&RBAC/Permission';
import { RolePermission } from '../../entities/Auth&RBAC/RolePermission';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';

import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

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
      throw new ConflictException('A role with this slug already exists');
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
      throw new NotFoundException('Role not found');
    }
    // Visible if it belongs to the tenant or is a shared system role.
    const ownedByTenant = (role.tenant?.id ?? null) === tenantId;
    if (!ownedByTenant && !role.is_system) {
      throw new NotFoundException('Role not found');
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
        throw new NotFoundException('One or more permissions do not exist');
      }
    }
    await this.replaceRolePermissions(role, permissionIds);
    return this.findOne(roleId, tenantId);
  }

  // --------------------------- user assignments -------------------------- //

  async assignRoleToUser(
    userId: string,
    roleId: string,
    tenantId: string | null,
  ): Promise<UserRole> {
    const user = await this.assertUserInTenant(userId, tenantId);
    const role = await this.findOne(roleId, tenantId); // enforces visibility

    const existing = await this.userRoles.findOne({
      where: { user: { id: user.id }, role: { id: role.id } },
    });
    if (existing) {
      throw new ConflictException('User already has this role');
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
      throw new NotFoundException('Role assignment not found');
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
      throw new NotFoundException('Role not found');
    }
    // A tenant can only mutate roles it owns. System roles (tenant null) are
    // mutable only by the super-admin (tenantId null) — handled by equality.
    if ((role.tenant?.id ?? null) !== tenantId) {
      throw new ForbiddenException('You cannot modify this role');
    }
    if (role.is_system && tenantId !== null) {
      throw new ForbiddenException('System roles cannot be modified');
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
      throw new NotFoundException('User not found');
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
