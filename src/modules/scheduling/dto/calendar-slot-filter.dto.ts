import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Filter + sort + pagination for calendar slots (always tenant-scoped). */
export class CalendarSlotFilterDto {
  @ApiPropertyOptional({ description: 'Filter by branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Filter by staff.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ description: 'Filter by availability flag.', example: true })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isAvailable?: boolean;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on start_time. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on start_time. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Sort by start_time.', enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sort?: 'asc' | 'desc';

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 50, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
