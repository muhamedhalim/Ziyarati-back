import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  CONFLICT_POLICIES,
  CONNECTION_AUTH_TYPE,
  INTEGRATION_PROVIDER_KEYS,
  SYNC_DIRECTIONS,
} from '../integration-platform.constants';

// `oauth2` is accepted here at the SHAPE level; whether it is actually usable
// is gated per-provider in the service (`provider.authTypes.includes(...)`,
// which in turn only lists oauth2 once `provider.oauth === true`). No trusted
// provider declares that yet, so submitting oauth2 today still fails — with a
// specific "not supported by this provider" message rather than a generic
// shape-validation error.
const SELECTABLE_AUTH_TYPES = [
  CONNECTION_AUTH_TYPE.NONE,
  CONNECTION_AUTH_TYPE.API_KEY,
  CONNECTION_AUTH_TYPE.SECRET,
  CONNECTION_AUTH_TYPE.BASIC,
  CONNECTION_AUTH_TYPE.OAUTH2,
];

/**
 * Register a new external-system connection for the caller's tenant. `provider`
 * must be a key from the trusted registry — arbitrary provider URLs are never
 * accepted. `credential` (if supplied) is encrypted at rest and never returned.
 * `config` is a structured, strictly-validated object (see
 * connections/connection-config.ts) — never an arbitrary blob.
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
    description:
      'The auth type\'s one secret value: the API key value, the bearer token, or the Basic Auth password. Encrypted at rest, never returned. Not applicable to "none" or "oauth2".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  credential?: string;

  @ApiPropertyOptional({
    description:
      'Structured connection configuration: base URL (required for providers with a real HTTP adapter), auth-specific non-secret fields (API key location/name, Basic Auth username), per-resource enable/direction overrides, and advanced Generic REST settings (endpoint paths, pagination, cursor field, custom headers).',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

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
