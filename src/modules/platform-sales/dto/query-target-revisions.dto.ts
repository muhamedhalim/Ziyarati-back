import { IsIn, IsOptional, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { SALES_METRIC } from '../../../entities/Sales/SalesTarget';
import type { SalesMetric } from '../../../entities/Sales/SalesTarget';
import { SalesPageQueryDto } from './sales-page-query.dto';

/** Target history of one employee, newest first; optionally narrowed to one month / metric. */
export class QueryTargetRevisionsDto extends SalesPageQueryDto {
  @ApiPropertyOptional({ example: '2026-09' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'period must be a month in the form YYYY-MM',
  })
  period?: string;

  @ApiPropertyOptional({ enum: SALES_METRIC })
  @IsOptional()
  @IsIn(SALES_METRIC)
  metric?: SalesMetric;
}
