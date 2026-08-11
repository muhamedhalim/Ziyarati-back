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
      'Optional clinic slug that narrows the account lookup to one clinic. Not required for staff or owner accounts — omitting it resolves the account by email alone, across every clinic and the platform.',
    example: 'al-noor-clinic',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tenantSlug?: string;
}
