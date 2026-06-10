import { PartialType } from '@nestjs/swagger';
import { CreateCustomerNoteDto } from './create-customer-note.dto';

/** Partial update of a customer note. */
export class UpdateCustomerNoteDto extends PartialType(CreateCustomerNoteDto) {}
