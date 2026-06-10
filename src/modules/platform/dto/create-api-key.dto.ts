import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

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
    description: 'Scopes granted to the key (stored as JSON).',
    type: [String],
    example: ['crm.read', 'appointments.read'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional({ description: 'Expiry timestamp (ISO-8601). Omit for no expiry.', example: '2027-01-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
