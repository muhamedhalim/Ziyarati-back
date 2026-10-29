import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PHONE_MESSAGE, PHONE_PATTERN } from '../../../common/utils/phone.util';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Create a customer for the caller's tenant.
 *
 * Schema notes (frozen entity): `phone` is required but NOT unique — multiple
 * customers may share one. `email` is optional and, when provided, unique per tenant among
 * live customers; `national_id` is optional but, when provided, is the sole
 * hard identity key (unique per tenant among live customers). Tenant is NEVER
 * taken from input — it comes from TenantContext.
 */
export class CreateCustomerDto {
  @ApiPropertyOptional({ description: 'Full name.', example: 'Sara Al-Otaibi' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  full_name?: string;

  @ApiProperty({
    description:
      'Phone number: 7–15 digits, optional leading +, separators allowed. Not unique — a household may share one; ' +
      'the same phone AND the same name is the same patient (409).',
    example: '+966500000000',
  })
  @IsString()
  @MaxLength(20)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone!: string;

  @ApiPropertyOptional({
    description:
      "Email (optional; unique among this tenant's live customers when provided).",
    example: 'sara@example.com',
    nullable: true,
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @ApiPropertyOptional({ description: 'WhatsApp id.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  whatsapp_id?: string;

  @ApiPropertyOptional({ description: 'WhatsApp display name.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  whatsapp_name?: string;

  @ApiPropertyOptional({ description: 'Gender.', example: 'female' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  gender?: string;

  @ApiPropertyOptional({
    description: 'Date of birth (ISO-8601 date).',
    example: '1990-05-20',
  })
  @IsOptional()
  @IsISO8601()
  date_of_birth?: string;

  @ApiPropertyOptional({
    description:
      "Client ID/identity number (unique among this tenant's live customers when provided). Letters, digits and dashes only.",
    example: '1234567890',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'national_id may only contain letters, digits and dashes',
  })
  national_id?: string;

  @ApiPropertyOptional({
    description: 'Acquisition source.',
    example: 'walk_in',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  @ApiPropertyOptional({
    description: 'Marketing opt-in.',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  marketing_opt_in?: boolean;

  @ApiPropertyOptional({
    description: 'Whether the customer is active.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({
    description:
      'Recipient locale for customer-facing notifications (M-09/CAP-I18N). Unset falls back to DEFAULT_LOCALE.',
    example: 'ar',
    enum: ['en', 'ar'],
  })
  @IsOptional()
  @IsIn(['en', 'ar'])
  preferred_locale?: string;

  @ApiPropertyOptional({
    description: 'Whether the patient has chronic diseases.',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  has_chronic_diseases?: boolean;

  @ApiPropertyOptional({
    description:
      'Chronic disease details. Required when has_chronic_diseases is true; ignored/cleared otherwise (enforced server-side, not just here).',
    example: 'Type 2 diabetes, hypertension',
  })
  @ValidateIf((o) => o.has_chronic_diseases === true)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  chronic_diseases?: string;

  @ApiPropertyOptional({
    description:
      "Whether the patient has health insurance. Tri-state: omitted/unset means never asked. Drives the AI booking flow's payment-link decision.",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  has_health_insurance?: boolean;
}
