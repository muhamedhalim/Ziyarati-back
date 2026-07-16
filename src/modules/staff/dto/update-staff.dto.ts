import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Updates mutable profile fields. `userId` is immutable (a profile is bound to
 * one user for life). Use the activate/deactivate endpoints for booking
 * availability toggling, though `isAvailableForBooking` is also accepted here.
 */
export class UpdateStaffDto {
  @ApiPropertyOptional({ description: 'Professional title.', example: 'Lead Physiotherapist', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ description: 'Biography / profile description.', example: 'Specialises in sports rehabilitation.' })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({
    description:
      'Storage key of a new/replacement avatar from `POST /uploads` (docType `staff-avatar`), or `null` to remove the current avatar. Omit entirely to leave it unchanged.',
    example: 'a1b2c3d4-0000-.../staff-avatar/8c2e0000-....jpg',
    maxLength: 1024,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(1024)
  avatarStorageKey?: string | null;

  @ApiPropertyOptional({
    description: 'Post-appointment buffer in minutes.',
    example: 15,
    minimum: 0,
    maximum: 240,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  bookingBufferMinutes?: number;

  @ApiPropertyOptional({
    description: 'Whether the staff member is currently bookable. Prefer the activate/deactivate endpoints for clarity.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isAvailableForBooking?: boolean;
}
