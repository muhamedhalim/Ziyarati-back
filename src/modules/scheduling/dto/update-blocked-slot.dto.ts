import { PartialType } from '@nestjs/swagger';
import { CreateBlockedSlotDto } from './create-blocked-slot.dto';

/** Partial update of a blocked period. */
export class UpdateBlockedSlotDto extends PartialType(CreateBlockedSlotDto) {}
