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

/** Filter + pagination for daily reports (always tenant-scoped). */
export class QueryDailyReportsDto {
  @ApiPropertyOptional({ description: 'Filter by branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'From day (YYYY-MM-DD, inclusive).', example: '2026-06-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ description: 'To day (YYYY-MM-DD, inclusive).', example: '2026-06-30' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 31, minimum: 1, maximum: 100, default: 31 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 31;
}
