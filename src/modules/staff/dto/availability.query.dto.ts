import { IsDateString, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Availability lookup: which staff are bookable at a branch on a given date.
 * Used by the booking UI and the WhatsApp bot.
 */
export class AvailabilityQueryDto {
  @ApiProperty({
    description: 'Branch to check availability at. Must belong to the caller\'s clinic.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
  })
  @IsUUID()
  branchId!: string;

  @ApiProperty({
    description: 'Date to check (`YYYY-MM-DD`). The weekday is derived from this date.',
    example: '2026-06-15',
    format: 'date',
  })
  @IsDateString()
  date!: string;
}
