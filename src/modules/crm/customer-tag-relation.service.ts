import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerTagRelation } from '../../entities/CRM/CustomerTagRelation';
import { Customer } from '../../entities/CRM/Customer';
import { CustomerTag } from '../../entities/CRM/CustomerTag';
import { AppError, ErrorCode } from '../../common/errors';

import { CustomerService } from './customer.service';
import { CustomerTagService } from './customer-tag.service';

/**
 * Customer ↔ tag assignments (M:N via `customer_tag_relations`).
 *
 * This join entity has NO tenant column, so isolation is enforced THROUGH its
 * endpoints: both the customer AND the tag are verified tenant-owned (via
 * CustomerService / CustomerTagService) before any write, and reads are scoped
 * by the already-verified customer. Assignment is idempotent (unique customer+tag).
 */
@Injectable()
export class CustomerTagRelationService {
  constructor(
    @InjectRepository(CustomerTagRelation)
    private readonly relations: Repository<CustomerTagRelation>,
    private readonly customers: CustomerService,
    private readonly tags: CustomerTagService,
  ) {}

  async assign(
    tenantId: string,
    customerId: string,
    tagId: string,
  ): Promise<CustomerTagRelation> {
    await this.customers.findOneOrThrow(tenantId, customerId);
    await this.tags.findOneOrThrow(tenantId, tagId);

    const existing = await this.relations.findOne({
      where: { customer: { id: customerId }, tag: { id: tagId } },
    });
    if (existing) return existing; // idempotent

    return this.relations.save(
      this.relations.create({
        customer: { id: customerId } as Customer,
        tag: { id: tagId } as CustomerTag,
      }),
    );
  }

  async remove(tenantId: string, customerId: string, tagId: string) {
    await this.customers.findOneOrThrow(tenantId, customerId);
    const relation = await this.relations.findOne({
      where: { customer: { id: customerId }, tag: { id: tagId } },
    });
    if (!relation) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Tag is not assigned to this customer',
      });
    }
    await this.relations.remove(relation);
    return { customerId, tagId, removed: true };
  }

  /** Tags assigned to a customer (customer is tenant-verified by the caller). */
  async listForCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerTagRelation[]> {
    await this.customers.findOneOrThrow(tenantId, customerId);
    return this.relations.find({
      where: { customer: { id: customerId } },
      relations: { tag: true },
      order: { created_at: 'DESC' },
    });
  }
}
