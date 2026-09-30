import { IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SalesOverviewQueryDto {
  @ApiPropertyOptional({
    example: '2026-09',
    description: 'UTC calendar month, YYYY-MM. Defaults to the current month.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'period must be a month in the form YYYY-MM',
  })
  period?: string;
}
