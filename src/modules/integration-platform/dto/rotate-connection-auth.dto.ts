import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import { INTEGRATION_PROVIDER_KEYS } from '../integration-platform.constants';
import { SELECTABLE_AUTH_TYPES } from './create-connection.dto';

/**
 * Safe auth-rotation workflow: rather than mutating an existing connection's
 * (immutable) auth type in place, this creates a REPLACEMENT connection with
 * the new auth type/credential, carries over the original's active mappings,
 * and retires (disconnects — never deletes) the original. Nothing is lost:
 * mappings, import/sync history and audit all survive on the new connection or
 * as preserved history on the old one.
 */
export class RotateConnectionAuthDto {
  @ApiPropertyOptional({ description: 'New provider key. Omit to keep the same provider.', enum: INTEGRATION_PROVIDER_KEYS })
  @IsOptional()
  @IsString()
  @IsIn(INTEGRATION_PROVIDER_KEYS)
  provider?: string;

  @ApiProperty({ description: 'New authentication type.', enum: SELECTABLE_AUTH_TYPES })
  @IsString()
  @IsIn(SELECTABLE_AUTH_TYPES)
  authType!: string;

  @ApiPropertyOptional({ description: 'The new auth type\'s credential (API key value / bearer token / Basic Auth password).' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  credential?: string;

  @ApiPropertyOptional({
    description:
      'Auth-specific non-secret settings for the new auth type (e.g. API key location/name, or Basic Auth username). Other settings — base URL, resource enablement, advanced Generic REST config — carry over from the existing connection unless overridden here.',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Human label for the replacement connection. Defaults to the existing name.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
