import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { QueryBoolean } from '../../../common/http/query-boolean.transform';
import type { RoleSlug } from '../../../rbac/rbac.constants';
import { PLATFORM_ASSIGNABLE_ROLE_SLUGS } from '../platform-staff.constants';

export class QueryPlatformStaffDto {
  @ApiPropertyOptional({
    description: 'Partial match on name or email.',
    example: 'sara',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by active/inactive.',
    example: true,
  })
  @IsOptional()
  // NOT `@Type(() => Boolean)`: that runs Boolean('false') === true, so the
  // "Inactive" filter used to return active staff.
  @QueryBoolean()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Filter to one platform role.',
    enum: PLATFORM_ASSIGNABLE_ROLE_SLUGS,
  })
  @IsOptional()
  @IsIn(PLATFORM_ASSIGNABLE_ROLE_SLUGS)
  role?: RoleSlug;

  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
