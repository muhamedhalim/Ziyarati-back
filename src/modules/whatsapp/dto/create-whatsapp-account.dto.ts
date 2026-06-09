import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
    description: 'Whether the account is active. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
