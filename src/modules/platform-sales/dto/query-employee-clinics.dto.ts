import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { SALES_ASSIGNMENT_KIND } from '../../../entities/Sales/SalesClinicAssignment';
import type { SalesAssignmentKind } from '../../../entities/Sales/SalesClinicAssignment';
import {
  SALES_PORTFOLIO_SORTABLE,
  SALES_PORTFOLIO_STATUS,
  SALES_SORT_DIRECTIONS,
} from '../platform-sales.constants';
import type {
  SalesPortfolioSort,
  SalesPortfolioStatus,
  SalesSortDirection,
} from '../platform-sales.constants';
import { SalesPageQueryDto } from './sales-page-query.dto';

/** One employee's clinic portfolio. */
export class QueryEmployeeClinicsDto extends SalesPageQueryDto {
  @ApiPropertyOptional({
    description: 'Partial match on clinic name, slug, contact email or phone.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: SALES_ASSIGNMENT_KIND })
  @IsOptional()
  @IsIn(SALES_ASSIGNMENT_KIND)
  kind?: SalesAssignmentKind;

  @ApiPropertyOptional({ enum: SALES_PORTFOLIO_STATUS, default: 'active' })
  @IsOptional()
  @IsIn(SALES_PORTFOLIO_STATUS)
  status: SalesPortfolioStatus = 'active';

  @ApiPropertyOptional({
    description:
      'Only clinics with NO logged activity by this employee in the last N days (never-worked clinics included).',
    minimum: 1,
    maximum: 3650,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  staleDays?: number;

  @ApiPropertyOptional({
    enum: SALES_PORTFOLIO_SORTABLE,
    default: 'assignedAt',
  })
  @IsOptional()
  @IsIn(SALES_PORTFOLIO_SORTABLE)
  sortBy: SalesPortfolioSort = 'assignedAt';

  @ApiPropertyOptional({ enum: SALES_SORT_DIRECTIONS, default: 'DESC' })
  @IsOptional()
  @IsIn(SALES_SORT_DIRECTIONS)
  sortDir: SalesSortDirection = 'DESC';
}
