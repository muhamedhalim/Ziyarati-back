import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PHONE_MESSAGE, PHONE_PATTERN } from '../../../common/utils/phone.util';

/**
 * Upsert the customer's 1:1 profile (extended demographic / clinical info).
 * All fields optional — only provided fields are written.
 */
export class UpdateCustomerProfileDto {
  @ApiPropertyOptional({ description: 'Medical history (free text).' })
  @IsOptional()
  @IsString()
  medical_history?: string;

  @ApiPropertyOptional({ description: 'Known allergies (free text).' })
  @IsOptional()
  @IsString()
  allergies?: string;

  @ApiPropertyOptional({ description: 'Blood type.', example: 'O+' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  blood_type?: string;

  @ApiPropertyOptional({ description: 'Emergency contact name.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  emergency_contact_name?: string;

  @ApiPropertyOptional({ description: 'Emergency contact phone.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  emergency_contact_phone?: string;

  @ApiPropertyOptional({ description: 'Internal profile notes (free text).' })
  @IsOptional()
  @IsString()
  notes?: string;
}
