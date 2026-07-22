import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { INTEGRATION_SCOPES } from '../integration-scopes.constants';

/**
 * Create an API key for external (machine-to-machine) integrations — ERP, HIS,
 * accounting, dashboards, etc. The plaintext key is returned ONCE in the
 * response and never again.
 */
export class CreateApiKeyDto {
  @ApiPropertyOptional({ description: 'Human label for the key.', example: 'ERP integration' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Integration scopes granted to the key. Must be from the fixed allowlist — never an ' +
      'internal RBAC permission slug — and the caller must already hold the internal permission ' +
      'each scope maps to (see integration-scopes.constants.ts), so a key can never exceed its ' +
      "issuer's own access.",
    type: [String],
    enum: INTEGRATION_SCOPES,
    example: ['integration.services.read', 'integration.appointments.read'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INTEGRATION_SCOPES.length)
  @IsString({ each: true })
  @IsIn(INTEGRATION_SCOPES, { each: true })
  permissions?: string[];

  @ApiPropertyOptional({ description: 'Expiry timestamp (ISO-8601). Omit for no expiry.', example: '2027-01-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
