import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerProfile } from '../../entities/CRM/CustomerProfile';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CustomerService } from './customer.service';
import { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto';

/**
 * Customer 1:1 profile (extended demographic / clinical info).
 *
 * Tenant-scoped via the `tenant` relation; the parent customer is verified
 * tenant-owned first (CustomerService). The profile is created lazily on first
 * upsert (it may not exist yet for a customer).
 */
@Injectable()
export class CustomerProfileService {
  constructor(
    @InjectRepository(CustomerProfile)
    private readonly profiles: Repository<CustomerProfile>,
    private readonly customers: CustomerService,
  ) {}

  async get(tenantId: string, customerId: string): Promise<CustomerProfile> {
    await this.customers.findOneOrThrow(tenantId, customerId);
    const profile = await this.profiles.findOne({
      where: { customer: { id: customerId }, tenant: { id: tenantId } },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Profile not set for this customer',
      });
    }
    return profile;
  }

  /** Create-or-update the profile (idempotent). */
  async upsert(
    tenantId: string,
    customerId: string,
    dto: UpdateCustomerProfileDto,
  ): Promise<CustomerProfile> {
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
    return this.profiles.save(profile);
  }
}
