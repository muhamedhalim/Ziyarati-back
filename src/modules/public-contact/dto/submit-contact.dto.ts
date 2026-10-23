import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CONTACT_LEAD_SUBJECT, type ContactLeadSubject } from '../../../entities/Sales/ContactLead';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimOrUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  return v === '' ? undefined : v;
};

/**
 * `POST /public/contact` - mirrors the web form's zod schema (`app/contact/schemas.ts`); this DTO
 * is the real validation, the client one is only a convenience.
 */
export class SubmitContactDto {
  @ApiProperty({ maxLength: 255 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fullName!: string;

  @ApiProperty({ maxLength: 254 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @Transform(trimOrUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @Transform(trimOrUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  facilityName?: string;

  @ApiProperty({ enum: CONTACT_LEAD_SUBJECT })
  @IsIn(CONTACT_LEAD_SUBJECT)
  subject!: ContactLeadSubject;

  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message!: string;

  @ApiPropertyOptional({ enum: ['en', 'ar'] })
  @IsOptional()
  @IsIn(['en', 'ar'])
  locale?: 'en' | 'ar';
}
