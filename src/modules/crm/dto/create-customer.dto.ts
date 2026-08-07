import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Create a customer for the caller's tenant.
 *
 * Schema notes (frozen entity): `phone` is required and unique per tenant;
 * `email` is a NOT-NULL, globally-unique column, so it is required here. Tenant
 * is NEVER taken from input — it comes from TenantContext.
 */
export class CreateCustomerDto {
  @ApiPropertyOptional({ description: 'Full name.', example: 'Sara Al-Otaibi' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  full_name?: string;

  @ApiProperty({ description: 'Phone number (unique per tenant).', example: '+966500000000' })
  @IsString()
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ description: 'Email (unique within this tenant).', example: 'sara@example.com' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

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

  @ApiPropertyOptional({ description: 'Date of birth (ISO-8601 date).', example: '1990-05-20' })
  @IsOptional()
  @IsISO8601()
  date_of_birth?: string;

  @ApiPropertyOptional({ description: 'Acquisition source.', example: 'walk_in' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  @ApiPropertyOptional({ description: 'Marketing opt-in.', example: false, default: false })
  @IsOptional()
  @IsBoolean()
  marketing_opt_in?: boolean;

  @ApiPropertyOptional({ description: 'Whether the customer is active.', example: true, default: true })
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
      'Whether the patient has health insurance. Tri-state: omitted/unset means never asked. Drives the AI booking flow\'s payment-link decision.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  has_health_insurance?: boolean;
}
