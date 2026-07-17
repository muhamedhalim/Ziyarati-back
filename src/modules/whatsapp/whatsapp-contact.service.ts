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

const PG_UNIQUE_VIOLATION = '23505';

/**
 * WhatsApp contacts.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; a linked
 * customer is re-validated against the tenant.
 *
 * Schema note: `whatsapp_contacts` has no status / opt-in column, so contact
 * status & subscription tracking are NOT persisted by this module.
 *
 * Uniqueness: `UQ_whatsapp_contact_tenant_wa_id` (partial, per tenant) is the
 * real backstop against duplicate contacts from concurrent inbound webhooks —
 * every write path below treats the resulting 23505 as "already exists", not
 * as a failure.
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
    try {
      return await this.contacts.save(contact);
    } catch (err) {
      if (dto.waId && (err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'A contact with this WhatsApp ID already exists for this tenant',
        });
      }
      throw err;
    }
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

    // Fast-path skip of wa_ids already present for the tenant. This is a
    // pre-check, not the guarantee — `UQ_whatsapp_contact_tenant_wa_id`
    // (partial unique per tenant) is what actually prevents a duplicate row
    // if a concurrent inbound webhook creates the same contact between this
    // check and the insert below.
    const waIds = dto.contacts.map((c) => c.waId);
    const existing = await this.contacts.find({
      where: { tenant: { id: tenantId }, wa_id: In(waIds) },
      select: { id: true, wa_id: true },
    });
    const existingSet = new Set(existing.map((e) => e.wa_id));

    const toInsert = dto.contacts.filter((c) => !existingSet.has(c.waId));
    let imported = 0;
    if (toInsert.length) {
      const rows = toInsert.map((c) =>
        this.contacts.create({
          tenant: { id: tenantId } as Tenant,
          customer: c.customerId ? ({ id: c.customerId } as Customer) : undefined,
          wa_id: c.waId,
          display_name: c.displayName,
        }),
      );
      try {
        await this.contacts.save(rows);
        imported = rows.length;
      } catch (err) {
        if ((err as { code?: string })?.code !== PG_UNIQUE_VIOLATION) throw err;
        // One row in the batch lost the uniqueness race — fall back to
        // per-row inserts so the rest of the batch still lands.
        for (const row of rows) {
          try {
            await this.contacts.save(row);
            imported += 1;
          } catch (rowErr) {
            if ((rowErr as { code?: string })?.code !== PG_UNIQUE_VIOLATION) throw rowErr;
          }
        }
      }
    }

    return {
      requested: dto.contacts.length,
      imported,
      skipped: dto.contacts.length - imported,
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
