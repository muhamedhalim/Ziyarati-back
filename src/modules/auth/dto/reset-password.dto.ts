import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  /** The raw reset token delivered to the user (e.g. via email). */
  @IsString()
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
