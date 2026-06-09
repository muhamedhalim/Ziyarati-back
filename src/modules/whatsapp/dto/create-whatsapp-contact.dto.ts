import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Creates a WhatsApp contact for the caller's tenant.
 *
 * Schema note: `whatsapp_contacts` has only `wa_id`, `display_name` and an
 * optional `customer` link — there is NO status / opt-in column, so
 * contact-status & subscription tracking are not persisted by this module.
 */
export class CreateWhatsappContactDto {
  @ApiProperty({
    description: 'WhatsApp id / phone (E.164 digits).',
    example: '966501234567',
    maxLength: 100,
  })
  @IsString()
  @MinLength(5)
  @MaxLength(100)
  waId!: string;

  @ApiPropertyOptional({ description: 'Display name.', example: 'Sara Al-Amin', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Link to an existing customer (tenant-scoped).',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}
