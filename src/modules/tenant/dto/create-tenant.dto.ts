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

export class CreateTenantDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must be lowercase alphanumeric with dashes',
  })
  slug!: string;

  /** Commercial registration is mandatory for clinic onboarding. */
  @IsString()
  @MaxLength(255)
  commercialRegistrationNumber!: string;

  @IsEmail()
  @MaxLength(255)
  contactEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  legalName?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32767) // smallint
  countryId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  defaultCurrency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  defaultTimezone?: string;
}
