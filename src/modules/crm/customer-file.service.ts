import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerFile } from '../../entities/CRM/CustomerFile';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';

import { CustomerService } from './customer.service';
import { CreateCustomerFileDto } from './dto/create-customer-file.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';

/**
 * Customer files (1:N) — METADATA ONLY (file_name / file_url / file_type). The
 * binary lives in external storage; this stores its location + the uploader.
 *
 * Tenant-scoped via the `tenant` relation; the parent customer is verified
 * tenant-owned first.
 */
@Injectable()
export class CustomerFileService {
  constructor(
    @InjectRepository(CustomerFile)
    private readonly files: Repository<CustomerFile>,
    private readonly customers: CustomerService,
  ) {}

  async upload(
    tenantId: string,
    customerId: string,
    dto: CreateCustomerFileDto,
    userId?: string,
  ): Promise<CustomerFile> {
    await this.customers.findOneOrThrow(tenantId, customerId);
    return this.files.save(
      this.files.create({
        customer: { id: customerId } as Customer,
        tenant: { id: tenantId } as Tenant,
        uploaded_by: userId ? ({ id: userId } as User) : undefined,
        file_url: dto.file_url,
        file_name: dto.file_name,
        file_type: dto.file_type,
      }),
    );
  }

  async remove(tenantId: string, customerId: string, fileId: string) {
    const file = await this.getMetadata(tenantId, customerId, fileId);
    await this.files.remove(file);
    return { id: fileId, deleted: true };
  }

  async list(
    tenantId: string,
    customerId: string,
    query: PaginationQueryDto,
  ) {
    await this.customers.findOneOrThrow(tenantId, customerId);
    const [data, total] = await this.files.findAndCount({
      where: { customer: { id: customerId }, tenant: { id: tenantId } },
      relations: { uploaded_by: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /** File metadata (the "download" payload — there is no binary here). */
  async getMetadata(
    tenantId: string,
    customerId: string,
    fileId: string,
  ): Promise<CustomerFile> {
    const file = await this.files.findOne({
      where: { id: fileId, customer: { id: customerId }, tenant: { id: tenantId } },
      relations: { uploaded_by: true },
    });
    if (!file) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'File not found' });
    }
    return file;
  }
}
