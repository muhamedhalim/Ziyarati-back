import { PartialType } from '@nestjs/swagger';
import { CreateWorkingHoursDto } from './create-working-hours.dto';

/** Partial update of a branch working-hours row (same overlap validation). */
export class UpdateWorkingHoursDto extends PartialType(CreateWorkingHoursDto) {}
