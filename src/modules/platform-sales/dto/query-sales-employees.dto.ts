import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { QueryBoolean } from '../../../common/http/query-boolean.transform';
import {
  SALES_EMPLOYEE_SORTABLE,
  SALES_SORT_DIRECTIONS,
} from '../platform-sales.constants';
import type {
  SalesEmployeeSort,
  SalesSortDirection,
} from '../platform-sales.constants';
import { SalesPageQueryDto } from './sales-page-query.dto';

export class QuerySalesEmployeesDto extends SalesPageQueryDto {
  @ApiPropertyOptional({
    example: '2026-09',
    description:
      'UTC month (YYYY-MM) whose targets and progress are attached to each row. Defaults to the current month.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'period must be a month in the form YYYY-MM',
  })
  period?: string;

  @ApiPropertyOptional({
    description: 'Partial match on name, email or phone.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by active / deactivated.' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: SALES_EMPLOYEE_SORTABLE, default: 'createdAt' })
  @IsOptional()
  @IsIn(SALES_EMPLOYEE_SORTABLE)
  sortBy: SalesEmployeeSort = 'createdAt';

  @ApiPropertyOptional({ enum: SALES_SORT_DIRECTIONS, default: 'DESC' })
  @IsOptional()
  @IsIn(SALES_SORT_DIRECTIONS)
  sortDir: SalesSortDirection = 'DESC';
}
