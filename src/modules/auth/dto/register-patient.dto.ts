import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Public B2C patient signup. No tenant, no role — patients are independent of
 * the SaaS tenant/RBAC model.
 */
export class RegisterPatientDto {
  @ApiProperty({
    description: 'Email address for the patient account. Must be globally unique across all patients.',
    example: 'patient@example.com',
    format: 'email',
    maxLength: 255,
  })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    description: 'Account password. Minimum 8 characters, maximum 72.',
    example: 'MySecret123!',
    minLength: 8,
    maxLength: 72,
    format: 'password',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiProperty({
    description: 'Full name of the patient.',
    example: 'Mohammed Al-Rashid',
    maxLength: 255,
  })
  @IsString()
  @MaxLength(255)
  fullName!: string;

  @ApiPropertyOptional({
    description: 'Mobile phone number (international format recommended). Used for WhatsApp appointment notifications.',
    example: '+966509998877',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
