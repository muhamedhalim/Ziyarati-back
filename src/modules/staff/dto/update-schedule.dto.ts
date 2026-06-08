import { PartialType } from '@nestjs/swagger';
import { CreateScheduleDto } from './create-schedule.dto';

/**
 * Partial update of a staff schedule slot. The same overlap validation applies
 * to the resulting (merged) slot.
 */
export class UpdateScheduleDto extends PartialType(CreateScheduleDto) {}
