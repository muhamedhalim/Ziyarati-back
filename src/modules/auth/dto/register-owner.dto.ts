import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Public clinic-onboarding payload. Creates a NEW tenant (clinic) and its
 * first user, who becomes the `owner`. Commercial registration is mandatory
 * for onboarding per the business rules.
 */
export class RegisterOwnerDto {
  // ── Owner identity ────────────────────────────────────────────────────
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MaxLength(255)
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  // ── Clinic (tenant) details ───────────────────────────────────────────
  @IsString()
  @MaxLength(255)
  clinicName!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must be lowercase alphanumeric with dashes',
  })
  slug!: string;

  @IsString()
  @MaxLength(100)
  commercialRegistrationNumber!: string;
}
