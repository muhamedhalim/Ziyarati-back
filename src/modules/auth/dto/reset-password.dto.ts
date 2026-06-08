import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({
    description:
      'The one-time reset token delivered to the user (e.g. via email or WhatsApp). Consumed on use — cannot be reused.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  /** The raw reset token delivered to the user (e.g. via email). */
  @IsString()
  token!: string;

  @ApiProperty({
    description: 'The new password to set. Minimum 8 characters, maximum 72.',
    example: 'NewStr0ng!Pass',
    minLength: 8,
    maxLength: 72,
    format: 'password',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
