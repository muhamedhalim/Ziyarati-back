import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Public clinic-onboarding payload. Creates a NEW tenant (clinic) and its
 * first user, who becomes the `owner`. Commercial registration is mandatory
 * for onboarding per the business rules.
 */
export class RegisterOwnerDto {
  // ── Owner identity ────────────────────────────────────────────────────

  @ApiProperty({
    description: 'Email address of the clinic owner. Used as the login identifier.',
    example: 'owner@al-noor.com',
    format: 'email',
    maxLength: 255,
  })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    description: 'Account password. Minimum 8 characters, maximum 72 (bcrypt limit).',
    example: 'Str0ng!Pass',
    minLength: 8,
    maxLength: 72,
    format: 'password',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiProperty({
    description: 'Full display name of the clinic owner.',
    example: 'Dr. Ahmed Hassan',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  fullName!: string;

  @ApiPropertyOptional({
    description: 'Mobile / contact phone number (international format recommended).',
    example: '+966501234567',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  // ── Clinic (tenant) details ───────────────────────────────────────────

  @ApiProperty({
    description: 'Display name of the clinic.',
    example: 'Al-Noor Medical Clinic',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  clinicName!: string;

  @ApiProperty({
    description:
      'URL-safe slug that uniquely identifies the clinic platform-wide. Used in the `tenantSlug` login field. **Immutable after creation.** Must be lowercase alphanumeric with dashes.',
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
    description: 'Official commercial registration number issued by the relevant government authority. Required for compliance.',
    example: '1010123456',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  commercialRegistrationNumber!: string;
}
