import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  password!: string;

  /**
   * Slug of the tenant the user is signing in to. Email uniqueness is scoped
   * per tenant, so this disambiguates which account is meant. Omit to sign in
   * as a platform super-admin (tenant_id NULL).
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tenantSlug?: string;
}
