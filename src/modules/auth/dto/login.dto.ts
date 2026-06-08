import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    description: 'Email address used at registration.',
    example: 'owner@al-noor.com',
    format: 'email',
    maxLength: 255,
  })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    description: 'Account password.',
    example: 'Str0ng!Pass',
    format: 'password',
  })
  @IsString()
  password!: string;

  @ApiPropertyOptional({
    description:
      'Slug of the clinic this user belongs to. **Required for staff and owner accounts.** Omit only when logging in as a platform super-admin (whose account has no tenant).',
    example: 'al-noor-clinic',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tenantSlug?: string;
}
