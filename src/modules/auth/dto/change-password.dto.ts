import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({
    description: 'The user\'s current password. Used as a re-authentication check.',
    example: 'OldStr0ng!Pass',
    format: 'password',
  })
  @IsString()
  currentPassword!: string;

  @ApiProperty({
    description: 'The new password to set. Minimum 8 characters, maximum 72.',
    example: 'NewStr0ng!Pass2',
    minLength: 8,
    maxLength: 72,
    format: 'password',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
