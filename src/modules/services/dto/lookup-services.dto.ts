import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Lightweight query for the service selector endpoint (`GET /services/lookup`).
 * Returns only active services; intended for dropdowns/typeaheads, not paging.
 */
export class LookupServicesDto {
  @ApiPropertyOptional({ description: 'Partial match on service name.', example: 'hair' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ description: 'Max results to return. Max 200.', example: 50, minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
