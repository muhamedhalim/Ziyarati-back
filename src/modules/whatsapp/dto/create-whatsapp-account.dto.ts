import {
  IsBoolean,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  WHATSAPP_ACCOUNT_MODE,
  WHATSAPP_ACCOUNT_MODES,
} from '../whatsapp.constants';

/**
 * Creates a WhatsApp business account for one branch of the caller's tenant.
 * The tenant comes from the authenticated principal — there is no tenantId
 * field. One account per branch (unique), validated against the tenant.
 */
export class CreateWhatsappAccountDto {
  @ApiProperty({
    description: 'Branch this WhatsApp account belongs to. Must belong to the caller\'s tenant. One account per branch.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
  })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({
    description:
      'Account mode. `CUSTOM` = the clinic\'s own WhatsApp number (default). ' +
      '`PLATFORM` = bind the branch to the shared SaaS number. A branch may have one of each.',
    enum: WHATSAPP_ACCOUNT_MODES,
    default: WHATSAPP_ACCOUNT_MODE.CUSTOM,
    example: WHATSAPP_ACCOUNT_MODE.CUSTOM,
  })
  @IsOptional()
  @IsIn(WHATSAPP_ACCOUNT_MODES)
  mode?: string;

  @ApiPropertyOptional({
    description: 'Meta phone number id for this WhatsApp number.',
    example: '1234567890',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  phoneNumberId?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp Business Account (WABA) id.',
    example: '9876543210',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  wabaId?: string;

  @ApiPropertyOptional({
    description:
      'Provider access token (write-only secret). It is stored encrypted-at-rest by infrastructure, NEVER returned in responses, and redacted in logs.',
    example: 'EAAG...redacted',
  })
  @IsOptional()
  @IsString()
  accessToken?: string;

  @ApiPropertyOptional({
    description:
      'Access-token expiry (ISO-8601). Recommended for rotated System User tokens so the platform can detect/replace expiring credentials.',
    example: '2026-12-31T00:00:00Z',
  })
  @IsOptional()
  @IsISO8601()
  tokenExpiresAt?: string;

  @ApiPropertyOptional({
    description: 'Whether the account is active. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
