import { PartialType } from '@nestjs/swagger';
import { CreateCustomerTagDto } from './create-customer-tag.dto';

/** Partial update of a customer tag. */
export class UpdateCustomerTagDto extends PartialType(CreateCustomerTagDto) {}
