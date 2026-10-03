import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const TENANT_USAGE_SORTABLE = [
  'name',
  'created_at',
  'status',
  'utilization',
  'lastActivity',
] as const;
export type TenantUsageSortBy = (typeof TENANT_USAGE_SORTABLE)[number];

/** Subscription-state filter for the tenant usage list (PART 4 reactivity). */
export const USAGE_STATE_FILTER = [
  'ACTIVE',
  'TRIAL',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
  'PENDING_PAYMENT', // a paid subscription whose first payment has not been captured
  'NONE', // no subscription at all
] as const;

/**
 * Server-side filtering / sorting / pagination for the super-admin tenant usage
 * list. All fields optional. `format` selects the export encoding.
 */
export class QueryTenantUsageDto {
  @ApiPropertyOptional({ description: 'Search by clinic name or slug.' })
  @IsOptional() @IsString() search?: string;

  @ApiPropertyOptional({ enum: USAGE_STATE_FILTER, description: 'Effective subscription state.' })
  @IsOptional() @IsIn(USAGE_STATE_FILTER as unknown as string[]) status?: string;

  @ApiPropertyOptional({ description: 'Filter to a specific plan id.' })
  @IsOptional() @IsString() planId?: string;

  @ApiPropertyOptional({ description: 'Only tenants that have exceeded at least one quota.' })
  @IsOptional() @IsIn(['true', 'false']) overLimit?: string;

  @ApiPropertyOptional({ description: 'Billing period `YYYY-MM` (defaults to current).' })
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodMonth must be YYYY-MM' })
  periodMonth?: string;

  @ApiPropertyOptional({ enum: TENANT_USAGE_SORTABLE, default: 'name' })
  @IsOptional() @IsIn(TENANT_USAGE_SORTABLE as unknown as string[]) sortBy: TenantUsageSortBy = 'name';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'ASC' })
  @IsOptional() @IsIn(['ASC', 'DESC']) sortDir: 'ASC' | 'DESC' = 'ASC';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;

  @ApiPropertyOptional({ enum: ['csv', 'excel'], default: 'csv', description: 'Export encoding.' })
  @IsOptional() @IsIn(['csv', 'excel']) format: 'csv' | 'excel' = 'csv';
}
