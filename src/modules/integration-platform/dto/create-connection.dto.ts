import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  CONFLICT_POLICIES,
  CONNECTION_AUTH_TYPE,
  INTEGRATION_PROVIDER_KEYS,
  SYNC_DIRECTIONS,
} from '../integration-platform.constants';

// Only the non-OAuth auth types are selectable at creation — OAuth provider
// endpoints/config come from trusted backend config that is not yet wired.
const SELECTABLE_AUTH_TYPES = [
  CONNECTION_AUTH_TYPE.NONE,
  CONNECTION_AUTH_TYPE.API_KEY,
  CONNECTION_AUTH_TYPE.SECRET,
];

/**
 * Register a new external-system connection for the caller's tenant. `provider`
 * must be a key from the trusted registry — arbitrary provider URLs are never
 * accepted. `credential` (if supplied) is encrypted at rest and never returned.
 */
export class CreateConnectionDto {
  @ApiProperty({ description: 'Human label for the connection.', example: 'Main clinic PMS' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ description: 'Provider key from the trusted registry.', enum: INTEGRATION_PROVIDER_KEYS })
  @IsString()
  @IsIn(INTEGRATION_PROVIDER_KEYS)
  provider!: string;

  @ApiPropertyOptional({ description: 'Authentication type.', enum: SELECTABLE_AUTH_TYPES, default: CONNECTION_AUTH_TYPE.NONE })
  @IsOptional()
  @IsString()
  @IsIn(SELECTABLE_AUTH_TYPES)
  authType?: string;

  @ApiPropertyOptional({
    description: 'Provider credential (bearer/secret). Encrypted at rest, never returned.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  credential?: string;

  @ApiPropertyOptional({ description: 'Data flow direction.', enum: SYNC_DIRECTIONS, default: 'bidirectional' })
  @IsOptional()
  @IsString()
  @IsIn(SYNC_DIRECTIONS)
  syncDirection?: string;

  @ApiPropertyOptional({ description: 'Default conflict policy.', enum: CONFLICT_POLICIES, default: 'reject_and_report' })
  @IsOptional()
  @IsString()
  @IsIn(CONFLICT_POLICIES)
  defaultConflictPolicy?: string;
}
