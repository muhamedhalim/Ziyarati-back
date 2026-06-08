import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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

  @ApiPropertyOptional({ description: 'Avatar image URL.', example: 'https://cdn.example.com/staff/avatar-1.png' })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

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
