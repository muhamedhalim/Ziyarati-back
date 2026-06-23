import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Filter + sort + pagination for API logs (always tenant-scoped).
 *
 * Schema note: `api_logs` has NO api_key or user/actor column, so filtering by
 * API key or user is not supported by the schema and is intentionally omitted.
 */
export class QueryApiLogsDto {
  @ApiPropertyOptional({ description: 'Partial match on endpoint.', example: '/api/v1/crm' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  endpoint?: string;

  @ApiPropertyOptional({ description: 'HTTP method.', example: 'GET' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  method?: string;

  @ApiPropertyOptional({ description: 'HTTP status code.', example: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  statusCode?: number;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on created_at. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on created_at. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Sort by created_at.', enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sort?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description:
      'Keyset cursor (created_at of the last seen row, ISO-8601). When set, results are fetched WITHOUT a COUNT(*) — required for scale on large log tables. Use `nextCursor` from the previous page.',
  })
  @IsOptional()
  @IsISO8601()
  cursor?: string;

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
