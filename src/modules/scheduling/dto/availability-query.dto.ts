import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Availability query. Different endpoints require different fields (enforced in
 * the service):
 *  - check / validate → branchId + staffId + startTime + endTime
 *  - windows          → branchId + staffId + date (+ optional slotMinutes)
 *  - summary          → branchId + date (+ optional staffId)
 */
export class AvailabilityQueryDto {
  @ApiProperty({ description: 'Branch to evaluate.', format: 'uuid' })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({ description: 'Staff member to evaluate.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ description: 'Target day (YYYY-MM-DD) — windows/summary.', example: '2026-07-06' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({ description: 'Window start (ISO-8601) — check/validate.', example: '2026-07-06T10:00:00Z' })
  @IsOptional()
  @IsISO8601()
  startTime?: string;

  @ApiPropertyOptional({ description: 'Window end (ISO-8601) — check/validate.', example: '2026-07-06T10:30:00Z' })
  @IsOptional()
  @IsISO8601()
  endTime?: string;

  @ApiPropertyOptional({ description: 'Chunk free windows into fixed slots of N minutes.', example: 30, minimum: 5, maximum: 1440 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  slotMinutes?: number;
}
