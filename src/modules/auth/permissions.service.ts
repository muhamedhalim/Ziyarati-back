import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Permission } from '../../entities/Auth&RBAC/Permission';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Permissions form a global catalogue (no tenant column): the set of actions
 * the platform recognises. Tenants consume them by attaching them to roles.
 * Mutating the catalogue is a super-admin operation (enforced at the controller).
 */
@Injectable()
export class PermissionsService {
  constructor(
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
  ) {}

  async create(dto: CreatePermissionDto): Promise<Permission> {
    const exists = await this.permissions.findOne({
      where: { slug: dto.slug },
    });
    if (exists) {
      throw new AppError(ErrorCode.CONFLICT, { message: 'A permission with this slug already exists' });
    }
    return this.permissions.save(this.permissions.create(dto));
  }

  findAll(module?: string): Promise<Permission[]> {
    return this.permissions.find({
      where: module ? { module } : {},
      order: { module: 'ASC', name: 'ASC' },
    });
  }

  async findOne(id: string): Promise<Permission> {
    const permission = await this.permissions.findOne({ where: { id } });
    if (!permission) {
      throw new AppError(ErrorCode.PERMISSION_NOT_FOUND);
    }
    return permission;
  }

  async update(id: string, dto: UpdatePermissionDto): Promise<Permission> {
    const permission = await this.findOne(id);
    Object.assign(permission, dto);
    return this.permissions.save(permission);
  }

  async remove(id: string): Promise<void> {
    const permission = await this.findOne(id);
    await this.permissions.remove(permission);
  }
}
