import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { CONFLICT_STATUS, INTEGRATION_RESOURCES } from '../integration-platform.constants';

/** Filter + pagination for persisted conflicts (always tenant-scoped). */
export class QueryConflictsDto {
  @ApiPropertyOptional({ description: 'Filter by connection.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  connectionId?: string;

  @ApiPropertyOptional({ description: 'Filter by resource type.', enum: INTEGRATION_RESOURCES })
  @IsOptional()
  @IsString()
  @IsIn(INTEGRATION_RESOURCES)
  resourceType?: string;

  @ApiPropertyOptional({ description: 'Conflict status.', enum: Object.values(CONFLICT_STATUS), default: 'pending' })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(CONFLICT_STATUS))
  status?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
