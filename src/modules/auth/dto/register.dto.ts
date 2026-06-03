import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt only hashes the first 72 bytes
  password!: string;

  @IsString()
  @MaxLength(255)
  fullName!: string;

  /**
   * Tenant the new user belongs to. Omit only when provisioning a platform
   * super-admin (tenant_id NULL), which is itself a privileged operation.
   */
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  /** Role slugs to assign on creation (must belong to the same tenant). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleSlugs?: string[];
}
