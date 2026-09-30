import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { TenantApprovalStatus } from '../../../entities/enums';
import {
  SALES_PICKER_ASSIGNMENT,
  SALES_PICKER_SORTABLE,
  SALES_SORT_DIRECTIONS,
} from '../platform-sales.constants';
import type {
  SalesPickerAssignment,
  SalesPickerSort,
  SalesSortDirection,
} from '../platform-sales.constants';
import { SalesPageQueryDto } from './sales-page-query.dto';

/** Clinic picker: which clinics can be handed to a sales employee. */
export class QuerySalesClinicsDto extends SalesPageQueryDto {
  @ApiPropertyOptional({
    description: 'Partial match on clinic name, slug, contact email or phone.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({
    enum: TenantApprovalStatus,
    description:
      'Omit to list every clinic except REJECTED ones (a rejected clinic is not a sales target).',
  })
  @IsOptional()
  @IsEnum(TenantApprovalStatus)
  approvalStatus?: TenantApprovalStatus;

  @ApiPropertyOptional({
    enum: SALES_PICKER_ASSIGNMENT,
    default: 'unassigned',
    description: 'Whether the clinic currently has an active sales owner.',
  })
  @IsOptional()
  @IsIn(SALES_PICKER_ASSIGNMENT)
  assignment: SalesPickerAssignment = 'unassigned';

  @ApiPropertyOptional({
    description:
      'Hide clinics this employee already owns, so add-clinics never offers what they already have.',
  })
  @IsOptional()
  @IsUUID('all')
  excludeEmployeeId?: string;

  @ApiPropertyOptional({ enum: SALES_PICKER_SORTABLE, default: 'name' })
  @IsOptional()
  @IsIn(SALES_PICKER_SORTABLE)
  sortBy: SalesPickerSort = 'name';

  @ApiPropertyOptional({ enum: SALES_SORT_DIRECTIONS, default: 'ASC' })
  @IsOptional()
  @IsIn(SALES_SORT_DIRECTIONS)
  sortDir: SalesSortDirection = 'ASC';
}
