import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTenantDto {
  @ApiProperty({
    description: 'Display name of the clinic.',
    example: 'Al-Noor Medical Clinic',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    description:
      'URL-safe slug that uniquely identifies the clinic platform-wide. Used as the `tenantSlug` field at login. **Immutable after creation.** Must be lowercase alphanumeric with dashes only.',
    example: 'al-noor-clinic',
    maxLength: 100,
    pattern: '^[a-z0-9-]+$',
  })
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must be lowercase alphanumeric with dashes',
  })
  slug!: string;

  @ApiProperty({
    description: 'Official commercial registration number issued by the relevant government authority.',
    example: '1010123456',
    maxLength: 255,
  })
  /** Commercial registration is mandatory for clinic onboarding. */
  @IsString()
  @MaxLength(255)
  commercialRegistrationNumber!: string;

  @ApiProperty({
    description: 'Primary contact email for the clinic.',
    example: 'admin@al-noor.com',
    format: 'email',
    maxLength: 255,
  })
  @IsEmail()
  @MaxLength(255)
  contactEmail!: string;

  @ApiPropertyOptional({
    description: 'Primary contact phone number for the clinic.',
    example: '+966112345678',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  contactPhone?: string;

  @ApiPropertyOptional({
    description: 'Official legal/registered business name (may differ from the display name).',
    example: 'Al-Noor Medical Services Company LLC',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  legalName?: string;

  @ApiPropertyOptional({
    description: 'URL of the clinic logo image.',
    example: 'https://cdn.example.com/clinics/al-noor/logo.png',
  })
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional({
    description: 'Country reference ID (FK to countries table).',
    example: 194,
    minimum: 1,
    maximum: 32767,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32767) // smallint
  countryId?: number;

  @ApiPropertyOptional({
    description: 'Default currency code (ISO 4217) for the clinic.',
    example: 'SAR',
    maxLength: 10,
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  defaultCurrency?: string;

  @ApiPropertyOptional({
    description: 'Default timezone for the clinic (IANA timezone identifier).',
    example: 'Asia/Riyadh',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  defaultTimezone?: string;
}
