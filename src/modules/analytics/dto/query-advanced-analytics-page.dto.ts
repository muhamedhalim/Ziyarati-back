import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { QueryAdvancedAnalyticsDto } from './query-advanced-analytics.dto';

/**
 * Spec 014 (Clinic Platform Completion) — T146 (US11, FR-A017). The shared
 * filter plus pagination, for the four list-shaped F11 routes
 * (performance/services, /staff, /branches, /channels).
 */
export class QueryAdvancedAnalyticsPageDto extends QueryAdvancedAnalyticsDto {
  @ApiPropertyOptional({
    description: 'Page number (1-based).',
    example: 1,
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Results per page. Max 100.',
    example: 20,
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
