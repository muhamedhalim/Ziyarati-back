import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Filter + pagination for analytics events (always tenant-scoped). */
export class QueryEventsDto {
  @ApiPropertyOptional({ description: 'Filter by event type.', example: 'appointment.created' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  eventType?: string;

  @ApiPropertyOptional({ description: 'Filter by entity type.', example: 'appointment' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @ApiPropertyOptional({ description: 'Filter by branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on created_at. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on created_at. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
