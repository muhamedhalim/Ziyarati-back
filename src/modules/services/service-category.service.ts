import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { ServiceCategory } from '../../entities/Services/ServiceCategory';
import { Service } from '../../entities/Services/Service';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateServiceCategoryDto } from './dto/create-service-category.dto';
import { UpdateServiceCategoryDto } from './dto/update-service-category.dto';
import { QueryServiceCategoriesDto } from './dto/query-service-categories.dto';

/**
 * Service categories — an optional grouping layer over the Service catalog.
 *
 * Tenant isolation: every query filters `where: { tenant: { id: tenantId } }`
 * and the tenant always comes from TenantContext (never from input). Soft delete
 * via `deleted_at`; `name` is unique per (non-deleted) tenant. A category cannot
 * be deleted while it still owns services — callers must reassign or remove those
 * services first.
 */
@Injectable()
export class ServiceCategoryService {
  constructor(
    @InjectRepository(ServiceCategory)
    private readonly categories: Repository<ServiceCategory>,
    @InjectRepository(Service)
    private readonly services: Repository<Service>,
  ) {}

  async create(tenantId: string, dto: CreateServiceCategoryDto): Promise<ServiceCategory> {
    await this.assertNameUnique(tenantId, dto.name);
    const category = this.categories.create({
      tenant: { id: tenantId } as Tenant,
      name: dto.name,
      description: dto.description,
      is_active: dto.isActive ?? true,
    });
    return this.categories.save(category);
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateServiceCategoryDto,
  ): Promise<ServiceCategory> {
    const category = await this.findOneOrThrow(tenantId, id);

    if (dto.name && dto.name !== category.name) {
      await this.assertNameUnique(tenantId, dto.name, id);
      category.name = dto.name;
    }
    if (dto.description !== undefined) category.description = dto.description;
    if (dto.isActive !== undefined) category.is_active = dto.isActive;

    return this.categories.save(category);
  }

  async remove(tenantId: string, id: string): Promise<{ id: string; deleted: boolean }> {
    await this.findOneOrThrow(tenantId, id);

    const owned = await this.services.count({
      where: { tenant: { id: tenantId }, category: { id } },
    });
    if (owned > 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'Cannot delete a category that still owns services. Reassign or remove its services first.',
        publicContext: { services: owned },
      });
    }

    await this.categories.softDelete(id);
    return { id, deleted: true };
  }

  async getDetails(tenantId: string, id: string): Promise<ServiceCategory> {
    return this.findOneOrThrow(tenantId, id);
  }

  async list(tenantId: string, query: QueryServiceCategoriesDto) {
    const where: FindOptionsWhere<ServiceCategory> = { tenant: { id: tenantId } };
    if (query.isActive !== undefined) where.is_active = query.isActive;
    if (query.search) where.name = ILike(`%${query.search}%`);

    const [data, total] = await this.categories.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /** Count of (non-deleted) categories for a tenant — used by service stats. */
  async count(tenantId: string): Promise<number> {
    return this.categories.count({ where: { tenant: { id: tenantId } } });
  }

  /** Bare ownership/existence check — reused by the Service service for validation. */
  async findOneOrThrow(tenantId: string, id: string): Promise<ServiceCategory> {
    const category = await this.categories.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!category) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Service category not found' });
    }
    return category;
  }

  private async assertNameUnique(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.categories.findOne({
      where: { tenant: { id: tenantId }, name },
    });
    if (existing && existing.id !== excludeId) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A service category with this name already exists',
      });
    }
  }
}
