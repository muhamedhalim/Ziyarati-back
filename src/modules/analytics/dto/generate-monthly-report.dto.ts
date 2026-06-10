import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * Generate (or recompute) a monthly report. `month` is YYYY-MM. Totals are
 * aggregated from that month's daily reports; rating/top-services are computed
 * from source. `branchId` optional: omit to batch all active branches.
 */
export class GenerateMonthlyReportDto {
  @ApiProperty({ description: 'Report month (YYYY-MM).', example: '2026-06' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @ApiPropertyOptional({ description: 'Restrict to a single branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
