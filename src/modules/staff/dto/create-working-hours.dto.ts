import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * Branch-level operating hours for one day of the week. (The `working_hours`
 * table is BRANCH-scoped, not per-staff — it bounds when the clinic is open and
 * therefore when staff can be booked.) Overlapping open slots for the same
 * branch + day are rejected.
 */
export class CreateWorkingHoursDto {
  @ApiProperty({
    description: 'Branch these operating hours apply to. Must belong to the caller\'s clinic.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
  })
  @IsUUID()
  branchId!: string;

  @ApiProperty({ description: 'Day of week. 0 = Sunday … 6 = Saturday.', example: 1, minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ description: 'Opening time `HH:MM` (24h).', example: '08:00' })
  @Matches(TIME_REGEX, { message: 'startTime must be HH:MM (24-hour)' })
  startTime!: string;

  @ApiProperty({ description: 'Closing time `HH:MM` (24h). Must be after startTime.', example: '18:00' })
  @Matches(TIME_REGEX, { message: 'endTime must be HH:MM (24-hour)' })
  endTime!: string;

  @ApiPropertyOptional({
    description: 'Mark the branch as closed for this day/slot. Closed slots do not participate in overlap checks. Defaults to false.',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isClosed?: boolean;
}
