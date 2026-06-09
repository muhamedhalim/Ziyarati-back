import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateWhatsappContactDto } from './dto/create-whatsapp-contact.dto';
import { UpdateWhatsappContactDto } from './dto/update-whatsapp-contact.dto';
import { WhatsappContactFilterDto } from './dto/whatsapp-contact-filter.dto';
import { BulkImportWhatsappContactsDto } from './dto/bulk-import-whatsapp-contacts.dto';

/**
 * WhatsApp contacts.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; a linked
 * customer is re-validated against the tenant.
 *
 * Schema note: `whatsapp_contacts` has no status / opt-in column, so contact
 * status & subscription tracking are NOT persisted by this module.
 */
@Injectable()
export class WhatsappContactService {
  constructor(
    @InjectRepository(WhatsappContact)
    private readonly contacts: Repository<WhatsappContact>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
  ) {}

  async create(tenantId: string, dto: CreateWhatsappContactDto): Promise<WhatsappContact> {
    if (dto.customerId) await this.assertCustomer(tenantId, dto.customerId);

    const contact = this.contacts.create({
      tenant: { id: tenantId } as Tenant,
      customer: dto.customerId ? ({ id: dto.customerId } as Customer) : undefined,
      wa_id: dto.waId,
      display_name: dto.displayName,
    });
    return this.contacts.save(contact);
  }

  /** Idempotent bulk import — existing wa_ids for the tenant are skipped. */
  async bulkImport(tenantId: string, dto: BulkImportWhatsappContactsDto) {
    // Validate any referenced customers belong to the tenant.
    const customerIds = [...new Set(dto.contacts.map((c) => c.customerId).filter(Boolean))] as string[];
    if (customerIds.length) {
      const found = await this.customers.count({
        where: { id: In(customerIds), tenant: { id: tenantId } },
      });
      if (found !== customerIds.length) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'One or more linked customers were not found in this tenant',
        });
      }
    }

    // Skip wa_ids already present for the tenant (no unique constraint exists).
    const waIds = dto.contacts.map((c) => c.waId);
    const existing = await this.contacts.find({
      where: { tenant: { id: tenantId }, wa_id: In(waIds) },
      select: { id: true, wa_id: true },
    });
    const existingSet = new Set(existing.map((e) => e.wa_id));

    const toInsert = dto.contacts.filter((c) => !existingSet.has(c.waId));
    if (toInsert.length) {
      await this.contacts.save(
        toInsert.map((c) =>
          this.contacts.create({
            tenant: { id: tenantId } as Tenant,
            customer: c.customerId ? ({ id: c.customerId } as Customer) : undefined,
            wa_id: c.waId,
            display_name: c.displayName,
          }),
        ),
      );
    }

    return {
      requested: dto.contacts.length,
      imported: toInsert.length,
      skipped: dto.contacts.length - toInsert.length,
    };
  }

  async findAll(tenantId: string, filter: WhatsappContactFilterDto) {
    const qb = this.contacts
      .createQueryBuilder('c')
      .leftJoin('c.tenant', 'tenant')
      .leftJoinAndSelect('c.customer', 'customer')
      .where('tenant.id = :tenantId', { tenantId });

    if (filter.search) {
      qb.andWhere('(c.display_name ILIKE :s OR c.wa_id ILIKE :s)', {
        s: `%${filter.search}%`,
      });
    }
    if (filter.customerId) qb.andWhere('customer.id = :cid', { cid: filter.customerId });
    if (filter.hasCustomer === 'true') qb.andWhere('customer.id IS NOT NULL');
    if (filter.hasCustomer === 'false') qb.andWhere('customer.id IS NULL');

    const [data, total] = await qb
      .orderBy('c.created_at', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<WhatsappContact> {
    const contact = await this.contacts.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { customer: true },
    });
    if (!contact) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Contact not found' });
    }
    return contact;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWhatsappContactDto,
  ): Promise<WhatsappContact> {
    const contact = await this.findOne(tenantId, id);
    if (dto.customerId !== undefined) {
      if (dto.customerId) {
        await this.assertCustomer(tenantId, dto.customerId);
        contact.customer = { id: dto.customerId } as Customer;
      } else {
        contact.customer = undefined;
      }
    }
    if (dto.waId !== undefined) contact.wa_id = dto.waId;
    if (dto.displayName !== undefined) contact.display_name = dto.displayName;
    return this.contacts.save(contact);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const contact = await this.findOne(tenantId, id);
    await this.contacts.remove(contact);
  }

  private async assertCustomer(tenantId: string, customerId: string): Promise<void> {
    const ok = await this.customers.exists({
      where: { id: customerId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Customer not found in this tenant',
      });
    }
  }
}
