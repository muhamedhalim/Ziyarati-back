import { PartialType } from '@nestjs/swagger';
import { CreateCustomerDto } from './create-customer.dto';

/** Partial update of a customer (all fields optional). */
export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}
