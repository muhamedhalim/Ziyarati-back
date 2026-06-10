import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Optional filter for the dashboard metrics read (always tenant-scoped). */
export class QueryDashboardDto {
  @ApiPropertyOptional({ description: 'Filter by a single metric key.', example: 'total_revenue' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  metricKey?: string;
}
