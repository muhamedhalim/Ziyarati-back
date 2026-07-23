import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  CONFLICT_POLICIES,
  SYNC_DIRECTIONS,
} from '../integration-platform.constants';

/**
 * Update a connection's mutable settings. `provider` and `authType` are fixed
 * after creation (changing them would invalidate stored credentials/mappings);
 * `credential` may be rotated (encrypted at rest, never returned).
 */
export class UpdateConnectionDto {
  @ApiPropertyOptional({ description: 'Human label.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Rotate the stored provider credential.' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  credential?: string;

  @ApiPropertyOptional({ description: 'Data flow direction.', enum: SYNC_DIRECTIONS })
  @IsOptional()
  @IsString()
  @IsIn(SYNC_DIRECTIONS)
  syncDirection?: string;

  @ApiPropertyOptional({ description: 'Default conflict policy.', enum: CONFLICT_POLICIES })
  @IsOptional()
  @IsString()
  @IsIn(CONFLICT_POLICIES)
  defaultConflictPolicy?: string;
}
