import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CustomerService } from './customer.service';
import { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto';

/** The 4 fields FR-H010a/d move behind `clinical.records.*` — kept in one place so the read-side strip and the write-side guard can never drift apart. */
const CLINICAL_PROFILE_FIELDS = [
  'medical_history',
  'allergies',
  'blood_type',
  'notes',
] as const;

/**
 * Customer 1:1 profile (extended demographic / clinical info).
 *
 * Tenant-scoped via the `tenant` relation; the parent customer is verified
 * tenant-owned first (CustomerService). The profile is created lazily on first
 * upsert (it may not exist yet for a customer).
 *
 * T108 (spec 014, US6, FR-H010a — BREAKING): this is the SAME privacy
 * boundary `CustomerService.getDetails` enforces, applied to this route's
 * OWN independent read/write path — FR-H010a is explicit that "two parallel
 * models MUST NOT coexist," so a caller without `clinical.records.*` must be
 * unable to read OR write these 4 fields through EITHER surface.
 */
@Injectable()
export class CustomerProfileService {
  constructor(
    @InjectRepository(CustomerProfile)
    private readonly profiles: Repository<CustomerProfile>,
    private readonly customers: CustomerService,
  ) {}

  async get(
    tenantId: string,
    customerId: string,
    hasClinicalAccess: boolean,
  ): Promise<CustomerProfile> {
    await this.customers.findOneOrThrow(tenantId, customerId);
    const profile = await this.profiles.findOne({
      where: { customer: { id: customerId }, tenant: { id: tenantId } },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Profile not set for this customer',
      });
    }
    if (!hasClinicalAccess) {
      for (const field of CLINICAL_PROFILE_FIELDS) {
        delete (profile as unknown as Record<string, unknown>)[field];
      }
    }
    return profile;
  }

  /**
   * Create-or-update the profile (idempotent). A caller without
   * `clinical.records.manage` who submits ANY of the 4 clinical fields is
   * refused with 403 — never silently dropped (silent data loss on an
   * explicit write is worse than telling the caller why).
   */
  async upsert(
    tenantId: string,
    customerId: string,
    dto: UpdateCustomerProfileDto,
    hasClinicalManage: boolean,
  ): Promise<CustomerProfile> {
    if (!hasClinicalManage) {
      const attempted = CLINICAL_PROFILE_FIELDS.filter(
        (field) => (dto as Record<string, unknown>)[field] !== undefined,
      );
      if (attempted.length > 0) {
        throw new AppError(ErrorCode.FORBIDDEN, {
          message: `Setting clinical field(s) requires clinical.records.manage: ${attempted.join(', ')}`,
        });
      }
    }

    await this.customers.findOneOrThrow(tenantId, customerId);

    let profile = await this.profiles.findOne({
      where: { customer: { id: customerId }, tenant: { id: tenantId } },
    });
    if (!profile) {
      profile = this.profiles.create({
        customer: { id: customerId } as Customer,
        tenant: { id: tenantId } as Tenant,
      });
    }

    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) (profile as any)[key] = value;
    }
    const saved = await this.profiles.save(profile);
    if (!hasClinicalManage) {
      for (const field of CLINICAL_PROFILE_FIELDS) {
        delete (saved as unknown as Record<string, unknown>)[field];
      }
    }
    return saved;
  }
}
