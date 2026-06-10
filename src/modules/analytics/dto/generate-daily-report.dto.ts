import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * Generate (or recompute) a daily report. `date` is a calendar day (YYYY-MM-DD).
 * `branchId` is optional: when given, only that branch's report is generated;
 * when omitted, reports are generated for ALL active branches (batch).
 */
export class GenerateDailyReportDto {
  @ApiProperty({ description: 'Report day (YYYY-MM-DD).', example: '2026-06-09' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({ description: 'Restrict to a single branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
