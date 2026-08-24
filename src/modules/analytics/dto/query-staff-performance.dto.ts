import { IsOptional, IsUUID, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Filter for the fleet-wide staff performance report (always tenant-scoped). */
export class QueryStaffPerformanceDto {
  @ApiPropertyOptional({ description: 'Filter by branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'From day (YYYY-MM-DD, inclusive). Defaults to 30 days ago.',
    example: '2026-06-01',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    description: 'To day (YYYY-MM-DD, inclusive). Defaults to today.',
    example: '2026-06-30',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}
