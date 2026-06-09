import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WHATSAPP_TEMPLATE_STATUSES } from '../whatsapp.constants';

/**
 * Creates a WhatsApp message template for the caller's tenant. Unique per
 * (tenant, name, language). New templates start in `draft`.
 */
export class CreateWhatsappTemplateDto {
  @ApiProperty({ description: 'Template name (provider-registered name).', example: 'appointment_reminder', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: 'BCP-47 language code.', example: 'ar', maxLength: 10 })
  @IsString()
  @MinLength(2)
  @MaxLength(10)
  language!: string;

  @ApiPropertyOptional({ description: 'Template category, e.g. `MARKETING`, `UTILITY`, `AUTHENTICATION`.', example: 'UTILITY', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({
    description: 'Template components (header/body/buttons) as provider JSON. Stored as JSONB.',
    type: 'object',
    additionalProperties: true,
    example: { body: { text: 'Hi {{1}}, your appointment is on {{2}}.' } },
  })
  @IsOptional()
  @IsObject()
  components?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'WhatsApp account this template is registered under. Must belong to the caller\'s tenant.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({
    description: 'Initial review status. Defaults to `draft`.',
    enum: WHATSAPP_TEMPLATE_STATUSES,
    example: 'draft',
    default: 'draft',
  })
  @IsOptional()
  @IsIn(WHATSAPP_TEMPLATE_STATUSES)
  status?: string;
}
