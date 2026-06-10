import { PartialType } from '@nestjs/swagger';
import { CreateCustomerAddressDto } from './create-customer-address.dto';

/** Partial update of a customer address. */
export class UpdateCustomerAddressDto extends PartialType(CreateCustomerAddressDto) {}
