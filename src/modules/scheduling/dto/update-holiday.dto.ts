import { PartialType } from '@nestjs/swagger';
import { CreateHolidayDto } from './create-holiday.dto';

/** Partial update of a holiday. */
export class UpdateHolidayDto extends PartialType(CreateHolidayDto) {}
