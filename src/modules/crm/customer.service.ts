
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, In, Repository } from 'typeorm';

import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { StaffScopeService } from '../../core/staff-scope/staff-scope.service';

import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { SearchCustomersDto } from './dto/search-customers.dto';
import { UsageService } from '../subscription-billing/usage.service';

/** How many same-phone rows are compared by name when a public booking arrives. */
const SAME_PHONE_LOOKUP_LIMIT = 20;

/**
 * The ONLY `UpdateCustomerDto` fields a provider (a doctor holding
 * `crm.customers.update_own` without `crm.customers.manage`) may change on a
 * patient they treat — contact and demographic details, plus the chronic-disease
 * intake answer. Everything else still needs `crm.customers.manage`:
 *   - `is_active`            deactivates the record
 *   - `marketing_opt_in`     a consent flag
 *   - `source`               attribution
 *   - `national_id`          the sole hard identity key
 *   - `whatsapp_id`/`_name`  the messaging identity the bot/inbox matches on
 *   - `has_health_insurance` drives the AI booking payment-link decision, i.e.
 *                            billing-adjacent
 * An explicit allow-list (not a deny-list) so a field added to the DTO later is
 * refused for providers until someone decides it is safe.
 */
export const PROVIDER_EDITABLE_CUSTOMER_FIELDS: ReadonlySet<string> = new Set([
  'full_name',
  'phone',
  'email',
  'gender',
  'date_of_birth',
  'preferred_locale',
  'has_chronic_diseases',
  'chronic_diseases',
]);

/**
 * A person's name reduced to what identifies them, for a same-person comparison:
 * compatibility-normalised, Arabic diacritics and tatweel dropped, whitespace
 * collapsed, case folded. An empty result never matches anything.
 */
function normalizePersonName(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

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
    private readonly staffScope: StaffScopeService,
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
   * F-19 — identity is NOT decided by the phone number alone. This runs for an
   * anonymous visitor, and nobody has proved the number is theirs: matching on it
   * used to attach the booking to whichever patient owned it and silently throw
   * the supplied name away, so anyone could put an appointment on a stranger's
   * record (and a parent booking a child on their own number overwrote the child
   * with the parent). An existing record is reused only when the phone AND the
   * name match. Anything else gets a record of its own — `phone` is deliberately
   * NOT unique, a shared household line is a supported case — and an existing
   * patient's record is never touched. What this still cannot do is prove the
   * person IS that patient: someone who knows both the number and the exact name
   * can still land on that record. Closing that needs a verification step (a code
   * sent to the number), which this path does not have.
   *
   * `email` is optional: when the patient doesn't give one it is stored as NULL
   * (no placeholder address is minted). A supplied address that already belongs
   * to another record is not attached to this one either — the booking proceeds
   * with no email instead. The `23505` retry closes the race where two concurrent
   * turns both miss the lookup and both insert.
   */
  async findOrCreateForBooking(
    tenantId: string,
    input: { fullName?: string; phone: string; email?: string },
  ): Promise<Customer> {
    const phone = input.phone.trim();
    const wanted = normalizePersonName(input.fullName);

    const findSamePerson = async (): Promise<Customer | undefined> => {
      if (!wanted) return undefined;
      const sharing = await this.customers.find({
        where: { tenant: { id: tenantId }, phone },
        order: { created_at: 'ASC' },
        take: SAME_PHONE_LOOKUP_LIMIT,
      });
      return sharing.find((c) => normalizePersonName(c.full_name) === wanted);
    };

    const existing = await findSamePerson();
    if (existing) return existing;

    const createWith = (email?: string) =>
      this.create(tenantId, {
        full_name: input.fullName,
        phone,
        email,
        source: 'public_ai',
      } as CreateCustomerDto);

    // No address supplied => the column stays NULL (it is nullable, and NULLs
    // are distinct in the tenant-scoped unique index).
    const supplied = input.email?.trim() || undefined;
    try {
      return await createWith(supplied);
    } catch (err) {
      // Concurrent insert won the race — re-read rather than failing the booking.
      const raced = await findSamePerson();
      if (raced) return raced;
      // The address the visitor typed belongs to a record that is not this person's
      // (or was just taken): book without one rather than fail, or attach.
      if (supplied) return createWith(undefined);
      throw err;
    }
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    const customer = await this.findOneOrThrow(tenantId, id);
    return this.applyUpdate(tenantId, id, customer, dto);
  }

  /**
   * Edit path for a provider holding `crm.customers.update_own` but NOT
   * `crm.customers.manage` (the doctor). Reached only from the controller,
   * which sends `manage` holders (and the integration API) through
   * {@link update} unchanged.
   *
   *   1. the customer must exist in THIS tenant (404 otherwise — a foreign
   *      tenant's id is indistinguishable from a missing one);
   *   2. the caller must have a (non-deleted) appointment with the patient
   *      (403 — patients are readable clinic-wide, so a 404 would hide
   *      nothing, and a clear refusal is the better answer);
   *   3. only {@link PROVIDER_EDITABLE_CUSTOMER_FIELDS} may carry a value
   *      (403 naming the refused fields — never silently dropped, mirroring the
   *      clinical-field rule in `CustomerProfileService.upsert`).
   */
  async updateOwnPatient(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
    const customer = await this.loadOwnPatientOrThrow(tenantId, userId, id);

    const refused = Object.entries(dto)
      .filter(
        ([key, value]) =>
          value !== undefined && !PROVIDER_EDITABLE_CUSTOMER_FIELDS.has(key),
      )
      .map(([key]) => key);
    if (refused.length > 0) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Changing ${refused.join(', ')} requires crm.customers.manage`,
      });
    }

    return this.applyUpdate(tenantId, id, customer, dto);
  }

  /**
   * Ownership gate for the provider's other write surface (the 1:1 profile).
   * Same rules 1–2 as {@link updateOwnPatient}.
   */
  async assertOwnPatient(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<void> {
    await this.loadOwnPatientOrThrow(tenantId, userId, id);
  }

  private async loadOwnPatientOrThrow(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<Customer> {
    const customer = await this.findOneOrThrow(tenantId, id);
    const owns = await this.staffScope.hasAppointmentWithCustomer(
      tenantId,
      userId,
      id,
    );
    if (!owns) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'You can only edit patients you have an appointment with',
      });
    }
    return customer;
  }

  private async applyUpdate(
    tenantId: string,
    id: string,
    customer: Customer,
    dto: UpdateCustomerDto,
  ): Promise<Customer> {
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

  /**
   * Full detail view: profile + addresses + assigned tags.
   *
   * T108 (spec 014, US6, FR-H010a/d — BREAKING) — `profile`'s clinical
   * fields (`medical_history`, `allergies`, `blood_type`, `notes`) are
   * stripped unless `hasClinicalAccess` is true (the caller holds
   * `clinical.records.read`). This is a FIELD-level filter, not a relation-
   * level one: `emergency_contact_name`/`emergency_contact_phone` live on
   * the SAME `CustomerProfile` entity and MUST stay visible to reception
   * (FR-H010e) — `Customer`-level fields (contact, addresses, tags,
   * `has_chronic_diseases`, `chronic_diseases`, `has_health_insurance`) are
   * entirely unaffected, they were never clinical.
   */
  async getDetails(
    tenantId: string,
    id: string,
    hasClinicalAccess: boolean,
  ): Promise<Customer> {
    const customer = await this.customers.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { profile: true, addresses: true, tags: { tag: true } },
    });
    if (!customer) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Customer not found',
      });
    }
    if (!hasClinicalAccess && customer.profile) {
      const {
        medical_history: _medicalHistory,
        allergies: _allergies,
        blood_type: _bloodType,
        notes: _notes,
        ...rest
      } = customer.profile;
      customer.profile = rest as typeof customer.profile;
    }
    return customer;
  }

  /**
   * T044 (015-db-api-efficiency-audit, P7-2/ORM-001/R-08): a relation-shaped
   * `where: { tenant: { id } }` creates the same join a `relations:` option
   * does, and combined with `skip`/`take` forces TypeORM's DISTINCT-id-then-
   * hydrate branch — 2 round trips, not 1 (research.md R-01/R-08/R-10). No
   * relation is actually needed here (the list never used one), so this is
   * built as a query builder filtering the FK column resolved from entity
   * metadata (no entity exposes it as a plain property — R-11), with
   * `.limit()/.offset()` instead of `.take()/.skip()` — `SelectQueryBuilder`
   * only enters the two-query branch on `skip`/`take`, never on `limit`/
   * `offset` (R-10). `getManyAndCount()` still hydrates full `Customer`
   * entities, so the response shape is unchanged.
   */
  async list(tenantId: string, query: QueryCustomersDto) {
    const tenantFk = this.fk(this.customers, 'tenant');
    const qb = this.customers
      .createQueryBuilder('c')
      .where(`c."${tenantFk}" = :tenantId`, { tenantId })
      .orderBy('c.created_at', 'DESC')
      .addOrderBy('c.id', 'DESC') // stable pagination — see note on ties
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
    if (query.isActive !== undefined) {
      qb.andWhere('c.is_active = :isActive', { isActive: query.isActive });
    }

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page: query.page, limit: query.limit };
  }

  /** Resolves `property`'s join-column database name from entity metadata —
   *  no entity exposes a relation's FK as a plain property (research.md
   *  R-11); the proven `DashboardSummaryService.fk()` pattern. */
  private fk(repo: Repository<Customer>, property: string): string {
    const relation = repo.metadata.findRelationWithPropertyPath(property);
    const column = relation?.joinColumns[0]?.databaseName;
    if (!column) {
      throw new Error(`${repo.metadata.name}.${property} has no join column`);
    }
    return column;
  }

  /**
   * Tenant-scoped search across name/email/phone/national_id (partial) + optional
   * tag filter. `national_id` is sensitive: it is matched here but never logged —
   * the term can reach a log only via the request URL, which the exception filter
   * redacts (`sanitizeUrlForLog`). Every OR branch spreads `base`, so tenant,
   * active and tag filters apply to a national_id match exactly as to the others.
   */
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
        { ...base, national_id: ILike(term) },
      ];
    }

    const [data, total] = await this.customers.findAndCount({
      where,
      relations: { tags: { tag: true } },
      order: { created_at: 'DESC', id: 'DESC' }, // id = stable-pagination tiebreaker
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
