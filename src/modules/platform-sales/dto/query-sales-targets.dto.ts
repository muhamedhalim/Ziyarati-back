import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { SALES_REASON_MAX } from '../platform-sales.constants';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `from` / `to` are inclusive months (`YYYY-MM`); both default to the current month. */
export class QuerySalesTargetsDto {
  @ApiPropertyOptional({ example: '2026-09' })
  @IsOptional()
  @Matches(MONTH, { message: 'from must be a month in the form YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09',
    description: 'At most 24 months after `from`.',
  })
  @IsOptional()
  @Matches(MONTH, { message: 'to must be a month in the form YYYY-MM' })
  to?: string;
}

export class DeleteSalesTargetQueryDto {
  @ApiPropertyOptional({ maxLength: SALES_REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(SALES_REASON_MAX)
  reason?: string;
}
