import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Filter + pagination for monthly reports (always tenant-scoped). */
export class QueryMonthlyReportsDto {
  @ApiPropertyOptional({ description: 'Filter by branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Filter by exact month (YYYY-MM).', example: '2026-06' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 12, minimum: 1, maximum: 100, default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 12;
}
