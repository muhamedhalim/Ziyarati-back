import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  SALES_PAGE_SIZE_DEFAULT,
  SALES_PAGE_SIZE_MAX,
} from '../platform-sales.constants';

/** Shared `page` / `limit` for every paged sales listing. */
export class SalesPageQueryDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: SALES_PAGE_SIZE_DEFAULT,
    minimum: 1,
    maximum: SALES_PAGE_SIZE_MAX,
    default: SALES_PAGE_SIZE_DEFAULT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SALES_PAGE_SIZE_MAX)
  limit: number = SALES_PAGE_SIZE_DEFAULT;

  offset(): number {
    return (this.page - 1) * this.limit;
  }
}
