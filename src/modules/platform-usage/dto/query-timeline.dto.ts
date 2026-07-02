import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Filtering / pagination / search for a tenant's usage history timeline (PART 3). */
export class QueryTimelineDto {
  @ApiPropertyOptional({ description: 'Free-text search over the event action/title.' })
  @IsOptional() @IsString() search?: string;

  @ApiPropertyOptional({ description: 'Filter by audit entity_type (e.g. platform_usage, marketplace_finance).' })
  @IsOptional() @IsString() type?: string;

  @ApiPropertyOptional({ description: 'Billing period `YYYY-MM` for the current-state snapshot.' })
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'periodMonth must be YYYY-MM' })
  periodMonth?: string;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional() @IsIn(['ASC', 'DESC']) sortDir: 'ASC' | 'DESC' = 'DESC';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}
