import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { INTEGRATION_RESOURCES } from '../integration-platform.constants';

/** Filter + pagination for external-id mappings (always tenant-scoped). */
export class QueryMappingsDto {
  @ApiPropertyOptional({ description: 'Filter by connection.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  connectionId?: string;

  @ApiPropertyOptional({ description: 'Filter by resource type.', enum: INTEGRATION_RESOURCES })
  @IsOptional()
  @IsString()
  @IsIn(INTEGRATION_RESOURCES)
  resourceType?: string;

  @ApiPropertyOptional({ description: 'Exact external id to look up.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalId?: string;

  @ApiPropertyOptional({ description: 'Exact internal record id to look up.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  internalResourceId?: string;

  @ApiPropertyOptional({ description: 'Partial match against either the external or the internal id.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({
    description:
      'Which mappings to return. `active` (default) = live correspondences; `unlinked` = history kept for audit/reconnect; `all` = both.',
    enum: ['active', 'unlinked', 'all'],
    default: 'active',
  })
  @IsOptional()
  @IsString()
  @IsIn(['active', 'unlinked', 'all'])
  scope?: 'active' | 'unlinked' | 'all';

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
