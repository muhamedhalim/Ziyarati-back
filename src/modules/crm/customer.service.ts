import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, In, Repository } from 'typeorm';

import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { SearchCustomersDto } from './dto/search-customers.dto';

/**
 * Customers — the core CRM aggregate root.
 *
 * Tenant isolation: `customers` is tenant-scoped via the `tenant` relation; every
 * query filters `where: { tenant: { id: tenantId } }` and the tenant always comes
 * from TenantContext (never from input). Supports soft delete (`deleted_at`).
 *
 * Schema notes (frozen): `phone` is unique per tenant; `email` is a NOT-NULL,
 * globally-unique column. Phone uniqueness is pre-checked tenant-scoped for a
 * friendly 409; email uniqueness is enforced by the DB constraint (mapped to 409)
 * to avoid any cross-tenant read.
 */
@Injectable()
export class CustomerService {
  private readonly logger = new Logger('CustomerService');

  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
  ) {}

  async create(tenantId: string, dto: CreateCustomerDto): Promise<Customer> {
    await this.assertPhoneUnique(tenantId, dto.phone);
    const customer = this.customers.create({
      tenant: { id: tenantId } as Tenant,
      full_name: dto.full_name,
      phone: dto.phone,
      email: dto.email,
      whatsapp_id: dto.whatsapp_id,
      whatsapp_name: dto.whatsapp_name,
      gender: dto.gender,
      date_of_birth: dto.date_of_birth ? new Date(dto.date_of_birth) : undefined,
      source: dto.source,
      marketing_opt_in: dto.marketing_opt_in ?? false,
      is_active: dto.is_active ?? true,
    });
    return this.customers.save(customer);
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    const customer = await this.findOneOrThrow(tenantId, id);

    if (dto.phone && dto.phone !== customer.phone) {
      await this.assertPhoneUnique(tenantId, dto.phone, id);
    }

    const { date_of_birth, ...rest } = dto;
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (customer as any)[key] = value;
    }
    if (date_of_birth !== undefined) {
      customer.date_of_birth = date_of_birth ? new Date(date_of_birth) : undefined;
    }

    return this.customers.save(customer);
  }

  async remove(tenantId: string, id: string): Promise<{ id: string; deleted: boolean }> {
    await this.findOneOrThrow(tenantId, id);
    await this.customers.softDelete(id);
    return { id, deleted: true };
  }

  /** Full detail view: profile + addresses + assigned tags. */
  async getDetails(tenantId: string, id: string): Promise<Customer> {
    const customer = await this.customers.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { profile: true, addresses: true, tags: { tag: true } },
    });
    if (!customer) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Customer not found' });
    }
    return customer;
  }

  async list(tenantId: string, query: QueryCustomersDto) {
    const where: FindOptionsWhere<Customer> = { tenant: { id: tenantId } };
    if (query.isActive !== undefined) where.is_active = query.isActive;

    const [data, total] = await this.customers.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /** Tenant-scoped search across name/email/phone (partial) + optional tag filter. */
  async search(tenantId: string, dto: SearchCustomersDto) {
    const base: FindOptionsWhere<Customer> = { tenant: { id: tenantId } };
    if (dto.isActive !== undefined) base.is_active = dto.isActive;
    if (dto.tagIds?.length) base.tags = { tag: { id: In(dto.tagIds) } };

    let where: FindOptionsWhere<Customer> | FindOptionsWhere<Customer>[] = base;
    if (dto.q) {
      const term = `%${dto.q}%`;
      where = [
        { ...base, full_name: ILike(term) },
        { ...base, email: ILike(term) },
        { ...base, phone: ILike(term) },
      ];
    }

    const [data, total] = await this.customers.findAndCount({
      where,
      relations: { tags: { tag: true } },
      order: { created_at: 'DESC' },
      skip: (dto.page - 1) * dto.limit,
      take: dto.limit,
    });
    return { data, total, page: dto.page, limit: dto.limit };
  }

  /** Bare ownership/existence check — reused by the sub-resource services. */
  async findOneOrThrow(tenantId: string, id: string): Promise<Customer> {
    const customer = await this.customers.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!customer) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Customer not found' });
    }
    return customer;
  }

  private async assertPhoneUnique(
    tenantId: string,
    phone: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.customers.findOne({
      where: { tenant: { id: tenantId }, phone },
    });
    if (existing && existing.id !== excludeId) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A customer with this phone already exists',
      });
    }
  }
}
