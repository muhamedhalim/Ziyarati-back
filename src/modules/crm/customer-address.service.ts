import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerAddress } from '../../entities/CRM/CustomerAddress';
import { Customer } from '../../entities/CRM/Customer';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CustomerService } from './customer.service';
import { CreateCustomerAddressDto } from './dto/create-customer-address.dto';
import { UpdateCustomerAddressDto } from './dto/update-customer-address.dto';

/**
 * Customer addresses (1:N). Tenant-scoped via the `tenant` relation; the parent
 * customer is verified tenant-owned first. Setting an address default unsets the
 * customer's other defaults.
 */
@Injectable()
export class CustomerAddressService {
  constructor(
    @InjectRepository(CustomerAddress)
    private readonly addresses: Repository<CustomerAddress>,
    private readonly customers: CustomerService,
  ) {}

  async add(
    tenantId: string,
    customerId: string,
    dto: CreateCustomerAddressDto,
  ): Promise<CustomerAddress> {
    await this.customers.findOneOrThrow(tenantId, customerId);
    if (dto.is_default) await this.clearDefault(tenantId, customerId);

    return this.addresses.save(
      this.addresses.create({
        customer: { id: customerId } as Customer,
        tenant: { id: tenantId } as Tenant,
        label: dto.label,
        address_line: dto.address_line,
        city: dto.city,
        is_default: dto.is_default ?? false,
      }),
    );
  }

  async update(
    tenantId: string,
    customerId: string,
    addressId: string,
    dto: UpdateCustomerAddressDto,
  ): Promise<CustomerAddress> {
    const address = await this.findOneOrThrow(tenantId, customerId, addressId);
    if (dto.is_default) await this.clearDefault(tenantId, customerId);

    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) (address as any)[key] = value;
    }
    return this.addresses.save(address);
  }

  async remove(tenantId: string, customerId: string, addressId: string) {
    const address = await this.findOneOrThrow(tenantId, customerId, addressId);
    await this.addresses.remove(address);
    return { id: addressId, deleted: true };
  }

  async list(tenantId: string, customerId: string): Promise<CustomerAddress[]> {
    await this.customers.findOneOrThrow(tenantId, customerId);
    return this.addresses.find({
      where: { customer: { id: customerId }, tenant: { id: tenantId } },
      order: { is_default: 'DESC' },
    });
  }

  private async findOneOrThrow(
    tenantId: string,
    customerId: string,
    addressId: string,
  ): Promise<CustomerAddress> {
    const address = await this.addresses.findOne({
      where: { id: addressId, customer: { id: customerId }, tenant: { id: tenantId } },
    });
    if (!address) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Address not found' });
    }
    return address;
  }

  private async clearDefault(tenantId: string, customerId: string): Promise<void> {
    await this.addresses.update(
      { customer: { id: customerId }, tenant: { id: tenantId } },
      { is_default: false },
    );
  }
}
