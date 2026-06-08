import { IsISO8601, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Date range for the staff commission summary report. */
export class CommissionSummaryQueryDto {
  @ApiPropertyOptional({
    description: 'Start of the reporting window (inclusive), ISO-8601. Defaults to the start of the current month.',
    example: '2026-06-01T00:00:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'End of the reporting window (exclusive), ISO-8601. Defaults to now.',
    example: '2026-07-01T00:00:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
