import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({
    description: 'Email address of the account to recover.',
    example: 'owner@al-noor.com',
    format: 'email',
    maxLength: 255,
  })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiPropertyOptional({
    description:
      'Clinic slug to scope the account lookup. Required for staff and owner accounts. Omit for super-admin recovery.',
    example: 'al-noor-clinic',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tenantSlug?: string;
}
