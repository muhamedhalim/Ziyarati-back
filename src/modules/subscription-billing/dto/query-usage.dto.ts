import { IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Selects the billing period for usage stats. */
export class QueryUsageDto {
  @ApiPropertyOptional({
    description: 'Billing period in `YYYY-MM`. Defaults to the current month.',
    example: '2026-06',
    pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'periodMonth must be YYYY-MM',
  })
  periodMonth?: string;
}
