import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Allowed profile fields only — never email, role, or status. */
export class UpdatePlatformStaffDto {
  @ApiPropertyOptional({ example: 'Sara Al-Amin', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fullName?: string;

  @ApiPropertyOptional({ example: '+966509876543', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ example: 'en', maxLength: 10 })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  preferredLocale?: string;
}
