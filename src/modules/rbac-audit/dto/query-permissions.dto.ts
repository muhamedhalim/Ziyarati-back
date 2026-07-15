import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { PERMISSION_SCOPES, RISK_LEVELS } from '../../../rbac/permission-metadata';

/** Whitelisted sortable columns — anything else is rejected by validation. */
export const PERMISSION_SORTABLE = [
  'name',
  'slug',
  'module',
  'scope',
  'risk',
  'status',
  'roleCount',
  'effectiveUserCount',
  'createdAt',
] as const;
export type PermissionSortBy = (typeof PERMISSION_SORTABLE)[number];

export const ASSIGNMENT_STATES = ['all', 'assigned', 'unassigned'] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export const METADATA_QUALITY = ['all', 'missing_description', 'complete'] as const;
export type MetadataQuality = (typeof METADATA_QUALITY)[number];

export const PERMISSION_STATUS_FILTER = ['all', 'active', 'deprecated'] as const;
export type PermissionStatusFilter = (typeof PERMISSION_STATUS_FILTER)[number];

/**
 * Server-side filter / sort / pagination for the permission audit table. All
 * fields optional; unknown combinations simply narrow the result. Sortable
 * columns are whitelisted (no arbitrary ORDER BY injection); free-text search
 * is parameterised in the service (no SQL injection).
 */
export class QueryPermissionsDto {
  @ApiPropertyOptional({ description: 'Free-text match on name, slug and description.', example: 'refund' })
  @IsOptional() @IsString() @MaxLength(120) search?: string;

  @ApiPropertyOptional({ description: 'Filter by module group.', example: 'payments' })
  @IsOptional() @IsString() @MaxLength(64) module?: string;

  @ApiPropertyOptional({ enum: PERMISSION_SCOPES, description: 'Filter by scope.' })
  @IsOptional() @IsIn(PERMISSION_SCOPES as unknown as string[]) scope?: string;

  @ApiPropertyOptional({ enum: RISK_LEVELS, description: 'Filter by risk level.' })
  @IsOptional() @IsIn(RISK_LEVELS as unknown as string[]) risk?: string;

  @ApiPropertyOptional({ enum: PERMISSION_STATUS_FILTER, default: 'all', description: 'Active vs deprecated.' })
  @IsOptional() @IsIn(PERMISSION_STATUS_FILTER as unknown as string[]) status: PermissionStatusFilter = 'all';

  @ApiPropertyOptional({ enum: ASSIGNMENT_STATES, default: 'all', description: 'Whether the permission is assigned to any role.' })
  @IsOptional() @IsIn(ASSIGNMENT_STATES as unknown as string[]) assignment: AssignmentState = 'all';

  @ApiPropertyOptional({ enum: METADATA_QUALITY, default: 'all', description: 'Metadata completeness filter.' })
  @IsOptional() @IsIn(METADATA_QUALITY as unknown as string[]) metadata: MetadataQuality = 'all';

  @ApiPropertyOptional({ enum: PERMISSION_SORTABLE, default: 'module' })
  @IsOptional() @IsIn(PERMISSION_SORTABLE as unknown as string[]) sortBy: PermissionSortBy = 'module';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'ASC' })
  @IsOptional() @IsIn(['ASC', 'DESC']) sortDir: 'ASC' | 'DESC' = 'ASC';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 25 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit: number = 25;
}
