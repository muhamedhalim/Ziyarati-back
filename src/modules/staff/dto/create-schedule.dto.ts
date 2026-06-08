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
 * One recurring weekly availability slot for a staff member at a branch.
 * Multiple rows for the same day represent multiple slots (e.g. a split shift).
 * The service rejects overlapping active slots on the same day for the staff.
 */
export class CreateScheduleDto {
  @ApiProperty({
    description: 'Branch this slot applies to. Must belong to the caller\'s clinic.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
  })
  @IsUUID()
  branchId!: string;

  @ApiProperty({
    description: 'Day of week. 0 = Sunday … 6 = Saturday.',
    example: 1,
    minimum: 0,
    maximum: 6,
  })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({
    description: 'Slot start time in 24h `HH:MM` (seconds optional).',
    example: '09:00',
  })
  @Matches(TIME_REGEX, { message: 'startTime must be HH:MM (24-hour)' })
  startTime!: string;

  @ApiProperty({
    description: 'Slot end time in 24h `HH:MM`. Must be after startTime.',
    example: '13:00',
  })
  @Matches(TIME_REGEX, { message: 'endTime must be HH:MM (24-hour)' })
  endTime!: string;

  @ApiPropertyOptional({
    description: 'Whether the slot is active. Inactive slots are ignored in availability + overlap checks. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
