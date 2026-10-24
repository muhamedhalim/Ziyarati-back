import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Adopt a library template into the clinic's own (draft) templates.
 *
 * Nothing here reaches Meta; it only fills install-time values into the copy.
 * Every field is optional — a value left out is simply left blank on the draft
 * and the owner is asked for it before the template can be submitted.
 */
export class AdoptLibraryTemplateDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "WhatsApp account the template will be submitted under. Must belong to the caller's tenant. Omitted = the tenant's default connected account.",
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({
    example: '+966501234567',
    description:
      "Clinic phone for the call button. Omitted = the clinic's contact phone, then the WhatsApp number.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^\+?[\d\s()-]{8,20}$/, {
    message: 'phoneNumber must look like a phone number',
  })
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: 'https://clinic.example.com/offers',
    description: 'Link opened by the offer template’s button. https only.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(/^https:\/\/[^\s{}]+$/i, {
    message: 'offerUrl must be an https:// link',
  })
  offerUrl?: string;
}
