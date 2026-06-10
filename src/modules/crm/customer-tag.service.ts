import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { CustomerTag } from '../../entities/CRM/CustomerTag';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateCustomerTagDto } from './dto/create-customer-tag.dto';
import { UpdateCustomerTagDto } from './dto/update-customer-tag.dto';
import { QueryCustomerTagsDto } from './dto/query-customer-tags.dto';

/**
 * Customer tag catalogue (`customer_tags`) for segmentation.
 *
 * Tenant-scoped via the `tenant` relation; tag name is unique per tenant (DB
 * index) and pre-checked for a friendly 409. Deleting a tag cascades its
 * customer relations at the DB level (FK onDelete CASCADE).
 */
@Injectable()
export class CustomerTagService {
  constructor(
    @InjectRepository(CustomerTag)
    private readonly tags: Repository<CustomerTag>,
  ) {}

  async create(tenantId: string, dto: CreateCustomerTagDto): Promise<CustomerTag> {
    await this.assertNameUnique(tenantId, dto.name);
    return this.tags.save(
      this.tags.create({
        tenant: { id: tenantId } as Tenant,
        name: dto.name,
        color: dto.color,
      }),
    );
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCustomerTagDto,
  ): Promise<CustomerTag> {
    const tag = await this.findOneOrThrow(tenantId, id);
    if (dto.name && dto.name !== tag.name) {
      await this.assertNameUnique(tenantId, dto.name, id);
    }
    if (dto.name !== undefined) tag.name = dto.name;
    if (dto.color !== undefined) tag.color = dto.color;
    return this.tags.save(tag);
  }

  async remove(tenantId: string, id: string) {
    const tag = await this.findOneOrThrow(tenantId, id);
    await this.tags.remove(tag); // relations cascade at the DB level
    return { id, deleted: true };
  }

  async list(tenantId: string, query: QueryCustomerTagsDto) {
    const where: FindOptionsWhere<CustomerTag> = { tenant: { id: tenantId } };
    if (query.q) where.name = ILike(`%${query.q}%`);

    const [data, total] = await this.tags.findAndCount({
      where,
      order: { name: 'ASC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /** Bare ownership/existence check — reused by the tag-relation service. */
  async findOneOrThrow(tenantId: string, id: string): Promise<CustomerTag> {
    const tag = await this.tags.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!tag) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Tag not found' });
    }
    return tag;
  }

  private async assertNameUnique(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.tags.findOne({
      where: { tenant: { id: tenantId }, name },
    });
    if (existing && existing.id !== excludeId) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A tag with this name already exists',
      });
    }
  }
}
