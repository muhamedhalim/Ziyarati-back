import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Create a holiday. `branchId` optional: omit for a company-wide holiday, set for
 * a branch-specific one. `is_recurring` makes it repeat yearly (same month/day).
 */
export class CreateHolidayDto {
  @ApiPropertyOptional({ description: 'Branch the holiday applies to (omit = company-wide).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Holiday name.', example: 'Eid Al-Fitr' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiProperty({ description: 'Holiday date (YYYY-MM-DD).', example: '2026-09-23' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({ description: 'Repeats yearly on the same month/day.', example: false, default: false })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
