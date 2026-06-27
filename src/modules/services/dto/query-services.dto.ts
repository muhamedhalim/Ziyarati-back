import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  DEFAULT_SERVICE_SORT_FIELD,
  DEFAULT_SORT_ORDER,
  SERVICE_SORTABLE_FIELDS,
} from '../services.constants';
import type { ServiceSortField } from '../services.constants';

/** Filter + sort + pagination for the service list (always tenant-scoped). */
export class QueryServicesDto {
  @ApiPropertyOptional({ description: 'Partial match on service name.', example: 'haircut' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by owning category UUID.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Filter by active flag.', example: true })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Minimum duration in minutes (inclusive).', example: 15, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minDuration?: number;

  @ApiPropertyOptional({ description: 'Maximum duration in minutes (inclusive).', example: 120, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxDuration?: number;

  @ApiPropertyOptional({ description: 'Minimum base price (inclusive).', example: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Maximum base price (inclusive).', example: 500, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({
    description: 'Sort column.',
    enum: SERVICE_SORTABLE_FIELDS,
    default: DEFAULT_SERVICE_SORT_FIELD,
  })
  @IsOptional()
  @IsIn(SERVICE_SORTABLE_FIELDS)
  sortBy: ServiceSortField = DEFAULT_SERVICE_SORT_FIELD;

  @ApiPropertyOptional({ description: 'Sort direction.', enum: ['ASC', 'DESC'], default: DEFAULT_SORT_ORDER })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['ASC', 'DESC'])
  sortOrder: 'ASC' | 'DESC' = DEFAULT_SORT_ORDER;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
