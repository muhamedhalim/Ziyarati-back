import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { CONNECTION_AUTH_TYPE, INTEGRATION_PROVIDER_KEYS } from '../integration-platform.constants';

const TESTABLE_AUTH_TYPES = [
  CONNECTION_AUTH_TYPE.NONE,
  CONNECTION_AUTH_TYPE.API_KEY,
  CONNECTION_AUTH_TYPE.SECRET,
  CONNECTION_AUTH_TYPE.BASIC,
];

/**
 * Test an UNSAVED (or partially edited) connection draft. Nothing is
 * persisted by this request. When `connectionId` is supplied and `credential`
 * is omitted, the existing stored credential is decrypted server-side and
 * used for the probe — it is never returned in the response.
 */
export class TestConnectionDto {
  @ApiPropertyOptional({
    description: 'Existing connection being edited. When set, an omitted `credential`/`config` field falls back to the stored value.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4')
  connectionId?: string;

  @ApiProperty({ description: 'Provider key from the trusted registry.', enum: INTEGRATION_PROVIDER_KEYS })
  @IsString()
  @IsIn(INTEGRATION_PROVIDER_KEYS)
  provider!: string;

  @ApiPropertyOptional({ description: 'Authentication type to test.', enum: TESTABLE_AUTH_TYPES, default: CONNECTION_AUTH_TYPE.NONE })
  @IsOptional()
  @IsString()
  @IsIn(TESTABLE_AUTH_TYPES)
  authType?: string;

  @ApiPropertyOptional({ description: 'The secret value to test with. Never persisted or returned.' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  credential?: string;

  @ApiPropertyOptional({ description: 'The draft structured configuration to test (base URL, auth fields, advanced settings).' })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
