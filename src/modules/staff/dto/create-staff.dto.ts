import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Creates a staff profile for an EXISTING user of the same clinic. The user is
 * created first via the auth flow (e.g. POST /auth/register-user); this links
 * that user to a bookable staff profile.
 *
 * Tenant scoping: there is no tenantId field — the tenant comes from the
 * authenticated principal, and the referenced user is validated to belong to it.
 */
export class CreateStaffDto {
  @ApiProperty({
    description: 'UUID of the existing user (same clinic) to turn into a staff member. One profile per user.',
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
    format: 'uuid',
  })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({
    description: 'Professional title shown to customers.',
    example: 'Senior Dermatologist',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    description: 'Short biography / profile description.',
    example: '10+ years of experience in cosmetic dermatology.',
  })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({
    description: 'Avatar image URL (already uploaded to storage).',
    example: 'https://cdn.example.com/staff/avatar-1.png',
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiPropertyOptional({
    description:
      'Buffer (in minutes) reserved after each appointment for this staff member before the next booking. Defaults to 0.',
    example: 10,
    minimum: 0,
    maximum: 240,
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  bookingBufferMinutes?: number;

  @ApiPropertyOptional({
    description: 'Whether the staff member is bookable immediately. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isAvailableForBooking?: boolean;
}
