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
import { UsageService } from '../subscription-billing/usage.service';

/**
 * Customers — the core CRM aggregate root.
 *
 * Tenant isolation: `customers` is tenant-scoped via the `tenant` relation; every
 * query filters `where: { tenant: { id: tenantId } }` and the tenant always comes
 * from TenantContext (never from input). Supports soft delete (`deleted_at`).
 *
 * Schema notes: `phone` and `email` are both NOT-NULL. `phone` is deliberately
 * NOT unique — multiple customers may legitimately share one (e.g. a shared
 * household line). `email` is unique PER TENANT among LIVE rows (FND-040/M-01 —
 * email was globally unique before; two tenants can now legitimately share a
 * customer's email) and enforced by the DB constraint alone (mapped to 409 by
 * `typeorm-error.mapper.ts`) — deliberately not pre-checked here, to avoid any
 * cross-tenant read. `national_id` is the sole hard identity key: optional, but
 * unique per tenant among LIVE rows when provided, pre-checked below for a
 * friendly 409. "Among LIVE rows" means a soft-deleted customer's email/
 * national_id is freed up for reuse — see
 * migration CrmCustomerSoftDeleteAwareUniqueness1730059000000.
 */
@Injectable()
export class CustomerService {
  private readonly logger = new Logger('CustomerService');

  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly usage: UsageService,
  ) {}

  async create(tenantId: string, dto: CreateCustomerDto): Promise<Customer> {
    // `max_customers` is a real plan cap and this is the deliberate "add a
    // patient" action, so it is the right place to refuse. Deliberately NOT
    // applied to `findOrCreateForBooking` below: refusing there would abort a
    // booking for a patient already mid-conversation with the clinic, turning a
    // billing limit into a lost appointment. Scoped to CRM via
    // `RESOURCE_LIMIT_FEATURE`, so a tenant running on a super-admin grant (no
    // plan, `UNMETERED_BY_PLAN`) passes rather than 404ing.
    await this.usage.assertResourceWithinLimit(
      tenantId,
      'customers',
      await this.customers.count({ where: { tenant: { id: tenantId } } }),
    );
    if (dto.national_id) {
      await this.assertNationalIdUnique(tenantId, dto.national_id);
    }
    const customer = this.customers.create({
      tenant: { id: tenantId } as Tenant,
      full_name: dto.full_name,
      phone: dto.phone,
      email: dto.email,
      whatsapp_id: dto.whatsapp_id,
      whatsapp_name: dto.whatsapp_name,
      gender: dto.gender,
      date_of_birth: dto.date_of_birth
        ? new Date(dto.date_of_birth)
        : undefined,
      national_id: dto.national_id,
      source: dto.source,
      marketing_opt_in: dto.marketing_opt_in ?? false,
      is_active: dto.is_active ?? true,
      preferred_locale: dto.preferred_locale,
      has_chronic_diseases: dto.has_chronic_diseases ?? false,
      chronic_diseases: dto.chronic_diseases,
      has_health_insurance: dto.has_health_insurance,
    });
    this.applyChronicDiseasesRule(customer);
    return this.customers.save(customer);
  }

  /**
   * Find-or-create the patient for a bot-driven booking, INSIDE `tenantId`.
   *
   * Promoted here from `WhatsappInboundAiService.findOrCreateCustomer` so the
   * public AI flow and the WhatsApp flow share one implementation instead of
   * growing a second, subtly different one.
   *
   * Tenant isolation is structural rather than conventional: every lookup here
   * is scoped `where: { tenant: { id: tenantId }, phone }`, so the SAME person
   * booking at two clinics necessarily gets two independent rows. Neither
   * clinic can see the other's — including notes, chronic diseases and
   * insurance status, which hang off the customer row.
   *
   * `phone` is NOT unique (a clinic's staff may legitimately record more than
   * one customer under the same number), so this matches the FIRST live row
   * with that phone in the tenant — acceptable for the booking-match heuristic
   * this method exists for, but callers should not assume it is the ONLY
   * customer with that phone.
   *
   * `email` is NOT NULL, so a synthetic tenant-unique address is minted when
   * the patient doesn't give one — the same convention the WhatsApp bridge uses.
   * The `23505` retry closes the race where two concurrent turns both miss the
   * lookup and both insert.
   */
  async findOrCreateForBooking(
    tenantId: string,
    input: { fullName?: string; phone: string; email?: string },
  ): Promise<Customer> {
    const phone = input.phone.trim();

    const existing = await this.customers.findOne({
      where: { tenant: { id: tenantId }, phone },
    });
    if (existing) return existing;

    try {
      return await this.create(tenantId, {
        full_name: input.fullName,
        phone,
        // Globally-unique synthetic address (the column is NOT NULL and unique
        // per tenant); tenantId + phone guarantees no collision.
        email:
          input.email?.trim() ||
          `patient+${tenantId}-${phone}@booking.internal`,
        source: 'public_ai',
      } as CreateCustomerDto);
    } catch (err) {
      // Concurrent insert won the race — re-read rather than failing the booking.
      const raced = await this.customers.findOne({
        where: { tenant: { id: tenantId }, phone },
      });
      if (raced) return raced;
      throw err;
    }
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    const customer = await this.findOneOrThrow(tenantId, id);

    if (dto.national_id && dto.national_id !== customer.national_id) {
      await this.assertNationalIdUnique(tenantId, dto.national_id, id);
    }

    const { date_of_birth, ...rest } = dto;
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (customer as any)[key] = value;
    }
    if (date_of_birth !== undefined) {
      customer.date_of_birth = date_of_birth
        ? new Date(date_of_birth)
        : undefined;
    }
    this.applyChronicDiseasesRule(customer);

    return this.customers.save(customer);
  }

  /**
   * Authoritative (not just DTO-level) enforcement of the chronic-disease
   * cross-field rule — the frontend and `@ValidateIf` on the DTO both check
   * this too, but this is the source of truth: `chronic_diseases` must be
   * non-empty when `has_chronic_diseases` is true, and is force-cleared
   * (including on a Yes→No edit that omits the field entirely) otherwise.
   */
  private applyChronicDiseasesRule(customer: Customer): void {
    if (customer.has_chronic_diseases) {
      if (!customer.chronic_diseases || !customer.chronic_diseases.trim()) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, {
          message:
            'chronic_diseases is required when has_chronic_diseases is true',
        });
      }
    } else {
      customer.chronic_diseases = null;
    }
  }

  async remove(
    tenantId: string,
    id: string,
  ): Promise<{ id: string; deleted: boolean }> {
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
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Customer not found',
      });
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

  /**
   * System-initiated consent-state write (FND-024). Deliberately NOT exposed
   * via `UpdateCustomerDto` / the public update endpoint — an opt-out must
   * only ever be set by genuine inbound-keyword detection (or another
   * verified system path), never spoofable through a normal PATCH request.
   */
  async recordOptOut(
    tenantId: string,
    customerId: string,
    source: string,
  ): Promise<void> {
    await this.customers.update(
      { id: customerId, tenant: { id: tenantId } },
      { opted_out_at: new Date(), opt_out_source: source },
    );
  }

  /**
   * System-initiated write of the patient's confirmed health-insurance
   * answer — used by the AI booking flow (`AiToolDispatchService`) to persist
   * an answer collected mid-conversation, outside the general `update()` DTO
   * path, so a returning patient's next booking can confirm it instead of
   * asking again.
   */
  async setInsuranceStatus(
    tenantId: string,
    customerId: string,
    hasInsurance: boolean,
  ): Promise<void> {
    await this.customers.update(
      { id: customerId, tenant: { id: tenantId } },
      { has_health_insurance: hasInsurance },
    );
  }

  /** Bare ownership/existence check — reused by the sub-resource services. */
  async findOneOrThrow(tenantId: string, id: string): Promise<Customer> {
    const customer = await this.customers.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!customer) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Customer not found',
      });
    }
    return customer;
  }

  /**
   * `national_id` is optional, so this is only ever called when a value is
   * actually given. The partial unique index
   * (`UQ_customers_tenant_national_id`, scoped to live rows only) is the real
   * backstop against a concurrent-insert race; this just gives the common
   * case a friendly 409 instead of a raw constraint violation. Uses the
   * repository's default (non-`withDeleted`) scope, so a soft-deleted
   * customer's national_id never blocks this check.
   */
  private async assertNationalIdUnique(
    tenantId: string,
    nationalId: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.customers.findOne({
      where: { tenant: { id: tenantId }, national_id: nationalId },
    });
    if (existing && existing.id !== excludeId) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A customer with this ID number already exists',
      });
    }
  }
}
