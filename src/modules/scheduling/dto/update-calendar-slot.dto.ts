import { PartialType } from '@nestjs/swagger';
import { CreateCalendarSlotDto } from './create-calendar-slot.dto';

/** Partial update of a calendar slot. */
export class UpdateCalendarSlotDto extends PartialType(CreateCalendarSlotDto) {}
