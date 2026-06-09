import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One contact in a bulk import. */
export class BulkWhatsappContactItemDto {
  @ApiProperty({ description: 'WhatsApp id / phone (E.164 digits).', example: '966501234567', maxLength: 100 })
  @IsString()
  @MinLength(5)
  @MaxLength(100)
  waId!: string;

  @ApiPropertyOptional({ description: 'Display name.', example: 'Sara Al-Amin', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @ApiPropertyOptional({ description: 'Link to a customer (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

/**
 * Bulk-imports contacts for the caller's tenant. Existing wa_ids are skipped
 * (idempotent). Capped per request; use multiple calls for very large lists.
 */
export class BulkImportWhatsappContactsDto {
  @ApiProperty({
    description: 'Contacts to import (max 1000 per request).',
    type: [BulkWhatsappContactItemDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => BulkWhatsappContactItemDto)
  contacts!: BulkWhatsappContactItemDto[];
}
